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

import { returnedValue as returnedValueOf } from '../../../packages/finance/src/day-book';
import { latestStoreReports, nothingUnsentAtFor } from './report-producers';
import { createHash, randomUUID } from 'node:crypto';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { Money, CurrencyCode } from '../../../packages/contracts/src/money';
import { money } from '../../../packages/contracts/src/money';
import type { AppendResult, BatchEntry, EventStore, PersistedEvent, WriteGuard } from '../../../packages/persistence/src/event-store';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { issuedSeriesFor, PrefixWriteRaced, type ReceiptPrefixDeps, type ReceiptPrefixIssue } from '../../platform/src/receipt-prefixes';
import { splitReceiptNumber, RECEIPT_COUNTER_MAX, RECEIPT_COUNTER_DIGITS } from '../../../packages/contracts/src/receipt-number';
import { notCanonical } from '../../platform/src/store-computer-identity';
import { stockValueCheckFor } from './finance-close-adapters';
import {
  foldBilling,
  type BillingEvent, type BillingSnapshot, type BillingRail, type DunningPolicy, type Mandate,
  type BillingSchedule, type Plan as BillingPlan, type RecurringBillingProvider,
} from '../../../packages/platform/src/index';
import type { BillingDeps, SubscribeOutcome, WebhookOutcome } from '../../platform/src/billing-routes';
import { OPTIONAL_FEATURES } from '../../../packages/tenant/src/index';
import { InMemorySnapshotStore, projectFromSnapshot, BUILD_LEASES_BUSY_HERE, type BuildLeaseHeld, type Projection, type SnapshotStore } from '../../../packages/persistence/src/index';
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
import { cessRateStore, frozenCessOf } from './till-bill-stores'; // Till bill and GST (A7)
import { apiError } from '../../kernel/src/index';
import type { GstRatePeriod } from '../../../packages/finance/src/rate';
import type { ProductRecord, BarcodeAssignment, MergeRequest, MergeLink, PackHierarchy, DataQualityFinding, SuggestionDisposition } from '../../../packages/product/src/index';
import { BarcodeRegistry, assessProductDataQuality, buildDataQualityWorklist } from '../../../packages/product/src/index';
import type { IncomingSale, IncomingTender, SaleException, PosDeps } from '../../pos/src/index';
import { heldReturnedStock, resolveSaleStockLocation, returnStockMovements, saleStockMovements, type HeldReturnedStock, type SaleStockLocation } from '../../pos/src/sale-stock';
import type { LotTraceDeps } from '../../inventory/src/lot-trace';
import type { RecallDeps } from '../../inventory/src/recall';
import { RecallRegistry, type RecallRecord } from '../../../packages/traceability/src/index';
import type { QualityHoldDeps } from '../../inventory/src/quality-hold';
import type { LoyaltyMemberDeps, LoyaltyRule, MemberRecord } from '../../customer/src/loyalty-members';
import type { LoyaltyWalletDeps, SpendApplied } from '../../customer/src/loyalty-wallets';
import type { LoyaltyLiabilityDeps } from '../../finance/src/loyalty-liability';
import { fulfilCompensation, type FulfilmentPorts, type CompensationFulfilment } from '../../customer/src/compensation-fulfilment';
import { monthEvidence, type IndependentEvidenceDeps, type ImportedStatement, type MonthEvidence } from '../../finance/src/independent-evidence';
import type { ControlTotalCheck } from '../../finance/src/index';
import { stockAdjustmentSources, stockAdjustmentCheck, type PeriodBooksDeps, type CountForBooks, type WriteOffForBooks, type StockAdjustmentJournal, type AccountClass } from '../../finance/src/period-books';
import { reconcilePayables, PAYABLES_LEFT_DERIVATION, PAYABLES_RIGHT_DERIVATION } from '../../../packages/finance/src/payables';
import type { LoyaltyEffectsDeps, SaleEarn, ReturnTakeBack, ReturnGiveBack } from '../../customer/src/loyalty-effects';
import { blockedProductIds, type SaleBlock, type SaleBlockDeps } from '../../inventory/src/sale-blocks';
import type { QualityHold } from '../../../packages/quality/src/index';
import type { SalesHistoryDeps } from '../../inventory/src/sales-history';
import type { SoldLine } from '../../../packages/demand/src/sales-history';
import type { OutboundLotRecord } from '../../../packages/quality/src/index';
import { attributeSalesFifo, nearExpiryStock, type BatchReceipt, type HistoricalSaleLine, type ReceiptWithExpiry, type SaleForNetOnHand, type ExpiryActionItem } from '../../../packages/fefo/src/index';
import type { NearExpiryDeps } from '../../inventory/src/near-expiry';
import type { ReturnsDeps, ReturnRecord, RecordedRefund, OriginalSale, RecordedReturn, StoreCreditIssue } from '../../pos/src/returns';
import type { ExchangeDeps } from '../../pos/src/exchanges';
import type { NoReceiptReturnsDeps } from '../../pos/src/no-receipt-returns';
import type { ApprovalUse, RefundApproval, RefundApprovalDeps, RefundApprovalState } from '../../pos/src/refund-approvals';
import type { ApprovalDecision, ApprovalRequest, ApprovalRequestDeps, ApprovalState, ApprovalPort } from '../../identity/src/approval-requests';
import type { RefusedDecision } from '../../migration/src/decisions';
import type { ExceptionResolution, MigrationException } from '../../../packages/migration/src/cleaning';
import type { ControlTotal, TotalSignature } from '../../../packages/migration/src/reconcile';
import type { CashDeps, RecordedCashMovement, TillMovement } from '../../pos/src/cash';
import type { PlacementTrigger } from '../../pos/src/till-store';
import type { ShiftDeps, ClosedShiftRecord, OverShortReview } from '../../pos/src/shift';
import type { DayCloseDeps, DayCloseRecord, DayReopenRecord } from '../../pos/src/day-close';
import type { B2BCreditDeps, B2BAccount, RecordedReceivable } from '../../finance/src/b2b-credit';
import type { B2BCollectionsDeps, Receivable as CollectionsReceivable, RecordedPayment } from '../../finance/src/b2b-collections';
import type { B2BCommissionDeps, CommissionAccrual } from '../../finance/src/b2b-commission';
import type { B2BDocumentsDeps, StoredB2BDocument } from '../../finance/src/b2b-documents';
import { checkCredit } from '../../../packages/b2b/src/credit';
import type { LpCasesDeps, LpRulesDeps, LpActivityDeps, TillActivity, RaisedException } from '../../pos/src/loss-prevention';
import type { InvestigationCase, EvidenceItem } from '../../../packages/loss-prevention/src/cases';
import { buildOpenCaseWorklist, type OpenCaseWorklist } from '../../../packages/loss-prevention/src/worklist';
import { openCase } from '../../../packages/loss-prevention/src/cases';
import { planInvestigationFromShortage } from '../../../packages/loss-prevention/src/auto-open-from-shortage';
import type { LpRule } from '../../../packages/loss-prevention/src/loss-prevention';
import type { FraudSignalsDeps } from '../../pos/src/fraud-signals';
import type { FraudThresholds } from '../../../packages/loss-prevention/src/fraud-signals';
import type { WarehouseDeps } from '../../inventory/src/warehouse';
import type { Bin, BinContents } from '../../../packages/warehouse/src/movements';
import { binKey } from '../../../packages/warehouse/src/movements';
import type { StockMovement } from '../../../packages/stock/src/position';
import type { TransfersDeps } from '../../inventory/src/warehouse-transfers';
import { shortfallLinesOf, shortfallLossOf, type AvailableLot, type ShortfallLoss, type Transfer, type TransferDiscrepancy } from '../../../packages/warehouse/src/transfers';
import { countCorrection, type CountsDeps, type StoredReconciliation, type CountPolicy } from '../../inventory/src/counts';
import type { WriteOffDeps, StoredWriteOff } from '../../inventory/src/write-off';
import { assertWriteOffReasonOnList } from '../../inventory/src/write-off';
import type { HeldStockDecisionDeps, HeldStockDecision } from '../../pos/src/held-stock-decisions';
import { recipeDigest, type ProductionDeps, type StoredRun, type StoredRelease } from '../../inventory/src/production';
import type { WeighedCostingDeps, StoredWeighedRun } from '../../inventory/src/weighed-costing';
import type { Recipe } from '../../../packages/production/src/recipe';
import type { SupplierPortalDeps, PartnerConfig, SubmissionRecord, SubmissionReview, StatementLine, PartnerAuditEntry } from '../../purchase/src/supplier-portal';
import type { ConcessionDeps, ConcessionContract, ConcessionSale, DepositMovement } from '../../finance/src/concession';
import type { ScrapDeps, ScrapSale } from '../../finance/src/scrap';
import type { FacilitiesDeps, MaintenanceSchedule, ScheduledTask, SafetyIncident } from '../../platform/src/facilities';
import type { FacilitiesAssetsDeps, Asset, ServiceLog, DowntimeEvent, EnergyReading } from '../../platform/src/facilities-assets';
import type { FacilitiesMonitoringDeps, EquipmentRangeReg, EquipmentContents, EquipmentReading, PowerEvent } from '../../platform/src/facilities-monitoring';
import type { PackagingDeps, PackagingItem, PackagingMovement } from '../../inventory/src/packaging';
import type { ComplianceDeps, Obligation } from '../../compliance/src/index';
import type { RiskRegisterDeps, Risk, Control, Incident, Remediation, Attestation } from '../../compliance/src/risk';
import type { DocumentsDeps, TemplateVersion, IssuedDocument } from '../../platform/src/documents';
import type { DocumentDisposal, TemplateDraft } from '../../../packages/documents/src/index';
import type { SuspendedBillsDeps, SuspendedBill } from '../../pos/src/suspended-bills';
import type { QuotationsDeps } from '../../pos/src/quotations';
import type { Quotation } from '../../../packages/suspended-sales/src/index';
import type { ScheduledBriefDeps, StoredSchedule } from '../../reporting/src/scheduled-brief';
import type { BriefLanguage } from '../../../packages/owner-control/src/index';
import type { EInvoiceRegisterDeps } from '../../finance/src/e-invoice-register';
import type { PayRunStoreDeps } from '../../finance/src/pay-run-store';
import type { RosterStoreDeps } from '../../finance/src/roster-store';
import type { CertStoreDeps } from '../../finance/src/cert-store';
import type { SopStoreDeps, Sop as WfSop } from '../../finance/src/sop-store';
import type { AttendanceStoreDeps, AttendanceRecord as WfAttendance } from '../../finance/src/attendance-store';
import type { ChecklistStoreDeps, StoredChecklist as WfChecklist } from '../../finance/src/checklist-store';
import type { TaskStoreDeps, TaskDefinition as WfTaskDef, TaskCompletion as WfTaskDone } from '../../finance/src/task-store';
import type { PayslipStoreDeps, IssuedPayslip } from '../../finance/src/payslip-store';
import type { Employee as WfEmployee, ShiftRequirement as WfShift, ShiftAssignment as WfAssignment, Certification as WfCertification, SopAcknowledgement as WfSopAck, DailyTask as WfDailyTask, TaskAssessment as WfTaskAssessment } from '../../../packages/workforce/src/workforce';
import { assessDailyTasks, taskGuidanceFindings } from '../../../packages/workforce/src/workforce';
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
import { replayConnectorQueue, type ConnectorDeliveryDeps, type ConnectorDeliveryEvent } from '../../platform/src/connector-delivery';
import type { SecretsDeps, SecretRef } from '../../platform/src/secrets';
import type { OrgStructureDeps, OrgNode, GstRegistration } from '../../platform/src/org-structure';
import type { DrReadinessDeps, DrDrillRecord } from '../../platform/src/dr-readiness';
import type { ShelfCountDeps, StoredShelfCount } from '../../inventory/src/shelf-count';
import type { PlanogramStoreDeps, StoredShelfMap, StoredPlanogram } from '../../inventory/src/planograms';
import { projectFleet, type DeviceRegistryDeps, type DeviceRegistryEvent } from '../../platform/src/device-registry';
import { projectVersionPolicy, type VersionPolicyDeps, type VersionPolicyEvent } from '../../platform/src/version-policy';
import type { PartnerDeps, PartnerCredential, Certification, SandboxTenant } from '../../platform/src/partners';
import { projectJobs, type BackgroundJobsDeps, type BackgroundJobEvent } from '../../platform/src/background-jobs';
import { projectSupportAccess, type SupportAccessDeps, type SupportAccessEvent } from '../../platform/src/support-access-lifecycle';
import { type StatusCentreDeps } from '../../platform/src/status-centre';
import { projectLicences, type LicenceDeps, type LicenceEvent } from '../../platform/src/licences';
import { projectServiceRequests, type ServiceRequestsDeps, type ServiceRequestEvent } from '../../platform/src/service-requests';
import { projectRemoteSessions, type RemoteSessionsDeps, type RemoteSessionEvent } from '../../platform/src/remote-sessions';
import { fleetSummary } from '../../../packages/platform-admin/src/devices';
import type { SpacePerformanceDeps } from '../../inventory/src/space-performance';
import type { AssortmentDeps } from '../../inventory/src/assortment';
import { rangeStatusOf } from '../../inventory/src/assortment';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import type { DisplayContract, AssortmentEntry } from '../../../packages/merchandising/src/index';
import type { DelegationDeps } from '../../identity/src/delegation';
import type { ApprovalDecisionDeps, ApprovalDecisionRecord } from '../../identity/src/approval-decisions';
import type { SyncedGoodsReceiptDeps } from '../../inventory/src/goods-receipt-synced';
import type { SyncedFloorIndentsDeps } from '../../inventory/src/floor-indents-synced';
import type { FloorIndent } from '../../../packages/warehouse/src/indents';
import type { AssembledGoodsReceiptDeps } from '../../inventory/src/goods-receipt-assembled';
import type { SyncedWarehouseDeps, ReceivingScanDeps, ReceivingScanRecord } from '../../inventory/src/warehouse-synced';
import type { SyncedCountsDeps } from '../../inventory/src/counts-synced';
import type { CountPlan, CountPlanDeps, VarianceCause, PlaceMovement } from '../../inventory/src/count-plans';
import { heldApplication, heldWriteOffViews, type HeldWriteOff, type HeldWriteOffApplied } from '../../inventory/src/held-write-offs';
import { budgetKey, openToBuyGuardKey, type OpenToBuyDeps, type PurchaseBudget, type BudgetOverride } from '../../purchase/src/open-to-buy';
import type { InvoiceIngestionDeps, InvoiceDocumentRecord, ItemMapping, ScanTypedLink } from '../../purchase/src/invoice-ingestion';
import { withTypedLinks } from '../../purchase/src/invoice-ingestion';
import { buffersAt, type OnlineBuffer, type OnlineBufferDeps } from '../../inventory/src/online-buffer';
import type { AdjustmentRequestDeps, AdjustmentRequestRecord } from '../../inventory/src/adjustment-requests';
import type { ProductReceiptRules } from '../../../packages/receiving/src/index';
import type { EmergencyAccessDeps, EmergencyGrant } from '../../identity/src/emergency-access';
import type { Delegation } from '../../../packages/approvals/src/index';
import type { DrillThroughDeps } from '../../reporting/src/drill-through';
import type { DrillAudit } from '../../../packages/owner-control/src/index';
import type { Hasher } from '../../../packages/audit/src/audit-trail';
import { AuditTrail, InMemoryAuditStore, type AuditEntry, type AuditRecord } from '../../../packages/audit/src/index';
import type { SettlementRoutesDeps, SettlementBatch, SettlementLine, CapturedTender } from '../../finance/src/settlement';
import { readMachineReference } from '../../../packages/tender/src/machine-reference';
import { attachEvidence, type Investigation } from '../../../packages/settlement/src/settlement';
import { project, projectBatches, fefoBatchesAt, EFFECT_ON_HAND, movesValueOnward } from '../../inventory/src/index';
import { minorPerUnitOf, normaliseUom, valueAtCost } from '../../../packages/contracts/src/quantity';
import type { Movement, Availability, BatchBalance, InventoryDeps, StockOwnership, InTransitStock, TransferShortfall } from '../../inventory/src/index';
import { splitStoreValuation, type OwnedStockValue, tagsAsConcessionSales, latestTagVersions, type ConcessionTag } from '../../../packages/concession/src/index';
import type { GoodsReceiptDeps, GrnRecord, StoredReceiptPolicy, PoReceiptPosting, ProductReceiptFacts } from '../../inventory/src/goods-receipt';
import { receiptRuleFor } from '../../inventory/src/goods-receipt';
import { COLD_CHAIN_CLASS_DEFAULTS } from '../../../packages/fulfilment/src/packing';
import { weightedAverageValuation, type ValuationMovement } from '../../../packages/stock/src/valuation';
import { agedStockLots, type DatedMovement } from '../../../packages/stock/src/ageing-source';
import type { BankChangeRequest, PurchaseDeps, SupplierInvoiceRecord, StoredMatch, StoredMatchPolicy } from '../../purchase/src/index';
import { capturePortalInvoice } from '../../purchase/src/index';
import type { Asn } from '../../../packages/receiving/src/asn';
import { foldAllSupplierAccounts, foldSupplierAccount, doorDebitNotesFrom, type SupplierAccountDeps, type SupplierPayment, type DebitNoteIssue, type DoorCheckInForAccount } from '../../purchase/src/supplier-account'; // R3 OB-196: doorDebitNotesFrom
import type { SupplierMasterDeps, SupplierRecord, SupplierBankState } from '../../purchase/src/supplier-master';
import { openingsWithSignOff, type SupplierOpeningDeps, type SupplierOpeningBalance, type SupplierOpeningSignOff, type SupplierOpeningReversal } from '../../purchase/src/supplier-openings';
import type { DisplayFundingDeps, DisplayFundingJournal } from '../../finance/src/display-funding';
import type { PayablesDeps, PayablesJournal, PayablesExceptionRecord } from '../../finance/src/payables';
import type { PurchaseOrderDeps, StoredPurchaseOrder } from '../../purchase/src/purchase-orders';
import { openDeliveriesFor } from '../../purchase/src/purchase-orders';
import type { StoreReplenishmentFacts } from '../../inventory/src/replenishment';
import type { SupplierScorecardDeps } from '../../purchase/src/supplier-scorecard';
import type { RebateDeps } from '../../purchase/src/rebates';
import type { RfqDeps } from '../../purchase/src/rfq';
import type { ImportQualityDeps, ImportJobRecord } from '../../purchase/src/import-quality';
import { assessMappingQuality, type MappingQualityFinding } from '../../../packages/import/src/index';
import type { DataImportDeps, ImportCommitRecord, ImportRollbackRecord } from '../../purchase/src/data-import';
import type { CategoryRegisterDeps, StoredCategory } from '../../catalogue/src/categories';
import type { StoreSettings, StoreRules, HeldVersionsReport } from '../../platform/src/store-packs';
import type { ImportEffect } from '../../purchase/src/import-templates';
import type { DataExportAuditDeps } from '../../purchase/src/data-export';
import type { ExportAudit } from '../../../packages/export/src/export';
import { projectAlerts, type AlertLifecycleDeps, type AlertLifecycleEvent, type LiveAlert } from '../../platform/src/alert-lifecycle';
import type { OpsIncidentDeps, IncidentFact } from '../../platform/src/ops-incidents';
import type { OutboundWebhookDeps, OutboundFact, OutboundTransport } from '../../platform/src/outbound-webhooks';
import { recommendOperationsRunbooks, type OperationsFinding } from '../../../packages/ops/src/index';
import { projectHolds, type LegalHoldsDeps, type LegalHoldEvent } from '../../finance/src/legal-holds';
import { computeOpenCommitment, type ReceiptFact, type SupplierContract, type RebateScheme, type RebateAccrual, type Requisition, type Quote } from '../../../packages/purchasing/src/index';
import type { JournalEntry, PeriodState, FinanceDeps } from '../../finance/src/index';
import type { AccountOpeningsDeps, AccountOpeningsRecord, AccountOpeningsSignOff } from '../../finance/src/account-openings';
import { openingEntryId, openingReversalEntryId } from '../../finance/src/account-openings';
import { postJournal } from '../../finance/src/index';
import { openedItemsOf, type OpeningItem, type OpenedItems } from '../../migration/src/opening-reversal';
import type { OpeningReversalDeps, CutoverGo, OpeningReversalRequest, OpeningReversalApproval, ReversalDomainLine } from '../../migration/src/opening-reversal';
import type { DayBookDeps, DayBookJournal, DayBookExceptionRecord, StoredPostingMap } from '../../finance/src/day-book';
import type { ConcessionTagDeps, ConcessionTradingBreach } from '../../finance/src/concession-tags';
import type { ObservedHealthDeps, ConnectorQueueDepth, BackupRecord, StoredAlertRules } from '../../platform/src/observed-health';
import type { DocumentTemplateDeps, DocumentTemplateVersion } from '../../platform/src/document-templates';
import { adapterHealth } from '../../../packages/integration/src/index';
import type { DayBookSale, DayBookLoyalty } from '../../../packages/finance/src/index';
import type { CreditNoteDeps } from '../../finance/src/credit-notes';
import type { CreditNote, ProductTaxEntry } from '../../../packages/finance/src/index';
import type { ConsentRecord, CustomerDeps, RecordedPointsMovement } from '../../customer/src/index';
import type { SegmentDeps } from '../../customer/src/segments';
import { collapseConsent } from '../../customer/src/segments';
import { assembleProfiles, draftMarketingAudiences } from '../../../packages/customer/src/index';
import type { SegmentPolicy, OrderFact, ComplaintFact, CustomerProfile as SegCustomerProfile, CustomerConsent as SegCustomerConsent, MarketingAudienceDraft } from '../../../packages/customer/src/index';
import type { DataRightsDeps, DataSubjectRequest } from '../../customer/src/data-rights';
import type { ErasureExecutionDeps, PiiEntry, ErasureApproval, DomainHolding } from '../../customer/src/erasure-execution';
import type { PrivacyTombstone } from '../../../packages/customer/src/index';
import type { ServiceCaseDeps, ServiceCase, CompensationRecord, DraftDecisionRecord } from '../../customer/src/service-cases';
import type { CampaignDeps, CampaignPlanRecord } from '../../customer/src/campaigns';
import type { CampaignSendDeps, CampaignFrequencyPolicy, CampaignSendRecord, DeliveryCallback } from '../../customer/src/campaign-send';
import type { ModelGatewayDeps, ModelCallAudit } from '../../ai/src/model-gateway';
import type { ModelTransport, ModelTier, TierPricing } from '../../../packages/ai/src/index';
import type { AiDraft, SatisfactionScore, CompensationPolicy, SlaView } from '../../../packages/service-desk/src/index';
import { assessFirstResponse } from '../../../packages/service-desk/src/index';
import type { StoredPointsMovement } from '../../../packages/loyalty/src/assess-points';
import type { StoredValueDeps, Instrument, ValueMovement } from '../../customer/src/stored-value';
import type { CouponDeps } from '../../customer/src/coupons';
import type { Coupon, Redemption } from '../../../packages/loyalty/src/coupons';
import { balanceOf } from '../../../packages/loyalty/src/stored-value';
import { spendRefFor } from '../../../packages/loyalty/src/wallet';
import type { PromotionDeps, LaunchRecord } from '../../pricing/src/promotions';
import type { PromotionCatalogueDeps } from '../../pricing/src/promotion-catalogue';
import type { Promotion } from '../../../packages/promotions/src/promotions';
import { expired } from '../../orders/src/index';
import type { B2BPortalDeps, B2BLoginBinding } from '../../finance/src/b2b-portal';
import type { B2BPortalRefusal } from '../../../packages/b2b/src/portal-access';
import type { ExceptionOwnershipDeps } from '../../orders/src/exception-ownership';
import type { OwnedException } from '../../../packages/orders/src/substitution-exception-ownership';
import type { PaymentRefundDeps } from '../../orders/src/payments';
import type { StorefrontDeps } from '../../orders/src/storefront';
import type { StorefrontAccessRefusal } from '../../../packages/orders/src/storefront-scope';
import { testModeRefundProcessor, paymentPosition, type OrderPayment, type OrderPaymentResolution, type OrderRefund, type OrderRefundOutcome, type RefundProcessor } from '../../../packages/orders/src/payment-refunds';
import type {
  Reservation, OrdersDeps, PlacedOrder, OrderTransition, OrderStateView, StoredSubstitution, StoredBackorder,
  SubstitutionTruthDeps, StoredSubstitutionRules, SubstitutionConsent,
} from '../../orders/src/index';
import type { ServiceabilityConfigDeps } from '../../orders/src/serviceability';
import type { ServiceabilityPeriod } from '../../../packages/storefront/src/index';
import { resolveServiceabilityPolicy } from '../../../packages/storefront/src/index';
import type { DeliveryServiceDeps, DeliveryServiceConfig, SlotBooking } from '../../orders/src/delivery-service';
import type { B2BStockPort } from '../../finance/src/b2b-documents';
import type { Customer360Deps, CustomerPurchase, CustomerReturn, CustomerCorrection, CustomerMerge, HouseholdLink, ProfileView } from '../../customer/src/customer-360';
import type { CommissionRuleDeps, CommissionRule } from '../../finance/src/b2b-commission';
import type { B2BOrderingDeps, B2BQuoteRequest, RecurringSchedule, RecurringRun } from '../../finance/src/b2b-ordering';
import type { B2BTransferNotesDeps, B2BTransferNote, B2BTransferDecision } from '../../finance/src/b2b-transfer-notes';
import { promise as promiseStock } from '../../orders/src/index';
import type { DeliveryAttempt, DeliveryStateRecord, FulfilmentDeps } from '../../fulfilment/src/index';
import type { AssignmentsDeps, WaveAssignment, RouteAssignment } from '../../fulfilment/src/assignments';
import type { DispatchDeps } from '../../fulfilment/src/dispatch';
import { assignedOrderIds, type DispatchPlan } from '../../../packages/fulfilment/src/index';
import { replayNotificationQueue, type NotificationQueueDeps, type NotificationQueueEvent, type MessageTemplateVersion, type RecipientStanding } from '../../customer/src/notification-queue';
import type { NotificationTransport, MessagingBudget } from '../../../packages/notifications/src/index';
import type { FulfilmentPackingDeps, PackResult, Manifest } from '../../fulfilment/src/packing';
import type { StockLossDeps, StockLossJournal } from '../../finance/src/stock-losses';
import type { B2BPostingDeps, B2BPostable, B2BJournal } from '../../finance/src/b2b-postings';
import type { OrderFulfilmentDeps, OrderHandback, FulfilmentSettlement } from '../../fulfilment/src/order-fulfilment';
import type { WaveSyncDeps, WaveLineOutcome, WavePackRecord } from '../../fulfilment/src/waves';
import type { SyncedDriverRunDeps, RouteStopUpdate, RouteSettlementRecord, CashHandoverRecord } from '../../fulfilment/src/driver-runs';
import type { IdentityDeps, GrantRequestRecord, PendingGrantRequest, GrantRejection } from '../../identity/src/index';
import type { TokenRevocation, TokenRevocationStore } from '../../identity/src/revocation';
import type { AccessLifecycleDeps, LifecycleChange } from '../../identity/src/access-lifecycle';
import { foldPeople, type PeopleDeps, type PersonSignInEvent } from '../../identity/src/people';
import type { IdentityDirectory } from '../../identity/src/identity-directory';
import { foldOutsideLogins, OUTSIDE_PARTY_ROLES, type OutsidePartyLoginDeps, type OutsideLoginEvent, type OutsideLoginRecord, type OutsidePartyRole } from '../../identity/src/outside-party-logins';
import { AccessControl, type Role, type RoleAssignment } from '../../../packages/rbac/src/rbac';
import type { DependencyProbe, FeatureFlagChange, PlatformDeps, ExportedEvent } from '../../platform/src/index';
import { inMemorySettings } from '../../platform/src/index';
import { buildTenantExport } from '../../../packages/platform/src/lifecycle';
import type { TenantBranding } from '../../../packages/platform/src/branding';
import type { DurableTenantSettings } from '../../../packages/tenant/src/index';
import { InMemoryNumberSeriesStore, type NumberSeriesStore } from '../../../packages/persistence/src/number-series-store';
import { PersonalDataSealingStore, type PersonalDataPolicy, type SubjectKeyStore } from '../../../packages/persistence/src/personal-data';
import { figure, sourceFreshness, syncedThrough } from '../../reporting/src/index';
import type { ReportingDeps, Figure, SourceFreshness, StoreSyncReport } from '../../reporting/src/index';
import { latestDomainReports, latestPerStore, type SyncWatermarkRecord } from '../../platform/src/sync-watermarks';
import type { BoxHealthRecord, BillNumberFinding, RefusalAcknowledgement, StoreComputerReplacement, AtRiskAcknowledgement, StoreBillFacts, IssuedReport } from '../../platform/src/box-health';
import {
  readNeverReceived, billNumberFindingsFor, judgeReportedIssued, weighSparseClaim, unusedButReceived, PLAUSIBLE_ISSUED_AHEAD, FOLD_SETTLE_MINUTES, UNRECEIVED_CHECK_CAP,
  readBoxHistoryInSteps, boxHistoryUnreadable, boxHistoryToStore, boxHistoryFromStore, BOX_HISTORY_STEP, UNUSED_HELD_TIMED_MAX, BoxHistoryPreparing,
  type UnusedCheckCapped, type BoxHistoryReading, type BoxHistoryState, type BoxHistorySealKey,
  type UnreceivedNumbers, type ClaimSlack, type JudgedAway, type NeverReceivedSnapshot, type PrefixBinding, type UnusedNumbers, type UnusedReceived,
  type UnreceivedCandidate, type UnusedReceivedAcknowledgement, type BoxHistorySnapshot, type BoxHistoryEntry, type BoxHistoryJudge, type BoxReportsView,
  registeredByStore, DOOR_REFUSAL_EXAMPLES_MAX, type LanePrefixRegistration, type DoorRefusalLine,
} from '../../platform/src/box-health';
import type { BranchScope } from '../../kernel/src/index';
import { tradingDayIn, tradingDayWindow, type TradingCalendar } from '../../../packages/calendar/src/index';
import type { ConsolidationDeps } from '../../reporting/src/consolidation-route';
import { salesSummary, ingestContribution } from '../../../packages/reporting/src/index';
import type { Producer, SaleFact, BranchContribution, BranchMembership } from '../../../packages/reporting/src/index';
import type { MigrationDeps, ParallelRunPolicy, RecordedParallelDay, RecordedRollback, AppliedDelta, LoadRecord, LoadApplied } from '../../migration/src/index';
import type { SliceAcceptance } from '../../../packages/migration/src/slice-import';
import type { ParallelDaySignature } from '../../../packages/migration/src/parallel-day-sign';
import type { ParallelDifference, RollbackReconciliation } from '../../../packages/migration/src/cutover';
import type { TargetKind } from '../../../packages/migration/src/trial';
import type { DomainFinding, Acceptance } from '../../../packages/migration/src/verification-report';
import type { Signature } from '../../../packages/migration/src/verification-report';
import type { HistoryExclusion } from '../../../packages/migration/src/history';
import type { AgentId, Budget, Proposal, EvidenceItem as AiEvidenceItem, AiDeps, InboxEntry } from '../../ai/src/index';
import type { PricingDeps, PriceChangeRecord } from '../../pricing/src/index';
import type { PriceListDeps } from '../../pricing/src/price-list';
import type { PriceEntry } from '../../../packages/price-list/src/price-list';
import { ROLE_CATALOGUE, STORE_MANAGER_ROLE_ID, STORE_COMPUTER_ROLE_ID, PROVIDER_RELAY_ROLE_ID, BACKUP_JOB_ROLE_ID, OWNER_ROLE_ID, isPlatformAdministrationRole } from './roles';
import { combinedDuties } from '../../identity/src/separation-of-duties';
import { isMachineCredential } from '../../identity/src/machine-identities';
import { metaOf as legacyAttachmentMeta, type LegacyHistoryDeps, type LegacyHistoryDocument, type LegacyAttachment, type LegacyAttachmentMeta } from '../../migration/src/legacy-history';

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
  /** Customer/CRM tenant-wide facts that are NOT per-customer consent — e.g. the segmentation policy
   *  (M16-FR-02): the tenant's boundaries for what counts as new/loyal/lapsing, one per tenant. */
  customer: 'customer',
  reservations: 'reservations',
  delivery: 'delivery',
  identity: 'identity',
  platform: 'platform',
  org: 'org',
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
  workforce: 'workforce',
  packaging: 'packaging',
  waste: 'waste',
  integration: 'integration',
  service: 'service',
  lossPrevention: 'loss-prevention',
  warehouse: 'warehouse',
  orders: 'orders',
  reporting: 'reporting',
  /** Data-subject privacy execution (M20-FR-04 / DPDP): the located-PII holdings, erasure approvals,
   *  sealed tombstones and processor-erasure notices — tenant-wide, append-only. */
  privacy: 'privacy',
  /** The domain-level, tamper-evident audit trail (M34-FR-01) — tenant-wide, append-only, one sealed
   *  record per sensitive action, NEVER folded (every record is its own fact; the chain is the evidence). */
  audit: 'audit',
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

/** The event that gives a role, and the event that takes it away again (Wave 2b · audit PA-02). */
export const ROLE_GRANTED = 'RoleGranted';
export const ROLE_REVOKED = 'RoleRevoked';

/** One grant's identity for the fold: who, which role, which scope. */
export function assignmentKey(a: RoleAssignment): string {
  return `${a.userId}\u0000${a.roleId}\u0000${a.branchScope === 'all' ? 'all' : [...a.branchScope].sort().join(',')}`;
}

/**
 * The grants a tenant's people hold NOW (Wave 2b · audit PA-02): every `RoleGranted` on the identity stream MINUS every
 * `RoleRevoked` that followed it for the same person, role and scope — folded in append order, so a role granted again
 * after a revocation stands. Before this, every reader folded `RoleGranted` alone and no grant could ever shrink: a
 * leaver kept their authority until somebody remembered to cut their token. Every reader of authority — the kernel's
 * resolver, every "does this approver hold…" check, every synced route's re-verification — goes through this ONE fold.
 */
export async function effectiveGrants(store: EventStore, tenantId: string): Promise<readonly RoleAssignment[]> {
  const events = await store.readStream(tenantId, STREAM.identity);
  const live = new Map<string, RoleAssignment[]>();
  for (const e of events) {
    if (e.event.type !== ROLE_GRANTED && e.event.type !== ROLE_REVOKED) continue;
    const a = payloadOf<RoleAssignment>(e);
    const k = assignmentKey(a);
    if (e.event.type === ROLE_GRANTED) live.set(k, [...(live.get(k) ?? []), { userId: a.userId, roleId: a.roleId, branchScope: a.branchScope }]);
    else live.delete(k);
  }
  return [...live.values()].flat();
}

/**
 * PA-12 round 10: every role a user holds at `at` — their effective grants plus any emergency grant still live (not
 * revoked, not expired). Read so a machine-only role is never mixed with a person's (identity/machine-identities.ts).
 */
export async function rolesHeldNow(store: EventStore, tenantId: string, userId: string, at: string): Promise<readonly string[]> {
  const granted = (await effectiveGrants(store, tenantId)).filter((g) => g.userId === userId).map((g) => g.roleId);
  return [...new Set([...granted, ...await liveEmergencyRoles(store, tenantId, userId, at)])];
}

/** OB-95 (and PA-12): the roles a user holds at `at` through an emergency grant still live (not revoked, not expired). */
export async function liveEmergencyRoles(store: EventStore, tenantId: string, userId: string, at: string): Promise<readonly string[]> {
  const emergency = (await allOf<EmergencyGrant>(store, tenantId, EMERGENCY_ACCESS_STREAM, 'EmergencyAccessRecorded'))
    .reduce((m, g) => m.set(g.grantId, g), new Map<string, EmergencyGrant>());
  return [...emergency.values()].filter((g) => g.userId === userId && (g.revokedAt ?? null) === null && Date.parse(g.expiresAt) > Date.parse(at)).map((g) => g.roleId);
}

const PERSON_SIGN_IN_EVENTS = new Set(['PersonSignInRequested', 'PersonSignInIssued', 'PersonSignInEnded', 'PersonSignInWithdrawn']);

/**
 * People's sign-ins at the identity server (OB-15-c): the attempt, the outcome and the end, on the identity ledger —
 * never a password. Whether a person holds a role is read from the same effective grants every reader folds.
 */
export function peopleAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Pick<PeopleDeps, 'now' | 'people' | 'recordPerson' | 'holdsAnyRole'> {
  const read = async (tenantId: string): Promise<PersonSignInEvent[]> =>
    (await input.store.readStream(tenantId, STREAM.identity))
      .filter((e) => PERSON_SIGN_IN_EVENTS.has(e.event.type))
      .map((e) => ({ ...payloadOf<Omit<PersonSignInEvent, 'type'>>(e), type: e.event.type } as PersonSignInEvent));
  return {
    now: input.now,
    people: async (tenantId) => foldPeople(await read(tenantId)),
    recordPerson: async (tenantId, event) => {
      const { type, ...payload } = event;
      const key = `${type}-${event.userId}-${event.at}`;
      await input.store.append(tenantId, STREAM.identity, makeEvent({
        id: `person-${key}`, type, occurredAt: event.at,
        idempotencyKey: `person-${tenantId}-${key}`, source: 'api/identity', payload,
      }));
    },
    holdsAnyRole: async (tenantId, userId) => (await effectiveGrants(input.store, tenantId)).some((g) => g.userId === userId),
  };
}

/**
 * PA-12 round 12: whether a user is a PERSON — anyone given (or asked to be given) a sign-in at the identity server
 * through /v1/identity/people, including one whose sign-in has since ended. A machine-only role is never theirs.
 */
export async function isPersonNow(store: EventStore, tenantId: string, userId: string): Promise<boolean> {
  return (await store.readStream(tenantId, STREAM.identity)).some((e) => PERSON_SIGN_IN_EVENTS.has(e.event.type) && e.event.type !== 'PersonSignInWithdrawn' && payloadOf<{ userId?: string }>(e).userId === userId);
}

/** A leaver's sign-in, switched off at the identity server and the end recorded on the ledger (OB-15-c). */
export function signInEnder(input: { readonly directory: IdentityDirectory; readonly people: ReturnType<typeof peopleAdapter>; readonly tenantId?: string }): {
  readonly end: (tenantId: string, userId: string, endedBy: string, at: string) => Promise<'ended' | 'none' | 'not_connected'>;
} {
  return {
    end: async (tenantId, userId, endedBy, at) => {
      // The directory provisions into ONE shop's realm (OB-15-d): another shop's leaver is not looked for there.
      if (input.tenantId !== undefined && input.tenantId !== tenantId) return 'not_connected';
      const outcome = await input.directory.end(userId);
      const known = (await input.people.people(tenantId)).some((p) => p.userId === userId && p.state !== 'ended');
      if (outcome === 'ended' || known) {
        await input.people.recordPerson(tenantId, { type: 'PersonSignInEnded', userId, endedBy, reason: 'leaver', at });
      }
      return outcome;
    },
  };
}

/**
 * The joiner / mover / leaver command's store (Wave 2b · audit PA-02). What the person holds NOW is read from the
 * ledger, never from the request; the change is ONE batch — a `RoleRevoked` per grant removed, a `RoleGranted` per grant
 * added — so a mover never holds the union of old and new for even a moment, and a leaver's authority ends on the very
 * ledger every reader folds. Idempotent on the request id.
 */
export function accessLifecycleAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly roleCatalogue: readonly Role[];
}): Omit<AccessLifecycleDeps, 'revocations' | 'recordAudit'> {
  return {
    now: input.now,
    roles: () => input.roleCatalogue,
    currentGrants: async (tenantId, userId) => (await effectiveGrants(input.store, tenantId)).filter((g) => g.userId === userId),
    // OB-95: a live emergency grant counts as held when a joiner/mover change is judged.
    emergencyRolesOf: (tenantId, userId) => liveEmergencyRoles(input.store, tenantId, userId, input.now()),
    isPerson: (tenantId, userId) => isPersonNow(input.store, tenantId, userId),
    outsideLoginOf: (tenantId, userId) => outsideLoginOf(input.store, tenantId, userId, input.now()),
    permissionsOf: async (tenantId, userId) => {
      const held = (await effectiveGrants(input.store, tenantId)).filter((a) => a.userId === userId);
      return [...new Set(held.flatMap((a) => input.roleCatalogue.find((r) => r.id === a.roleId)?.permissions ?? []))].sort();
    },
    recordChange: async (tenantId, change: LifecycleChange) => {
      const at = input.now();
      const provenance = {
        kind: 'lifecycle', requestId: change.requestId, event: change.event,
        requestedBy: change.requestedBy, approvedBy: change.approvedBy, reason: change.reason,
      };
      const entries: BatchEntry[] = [
        ...change.removed.map((a, i) => ({ stream: STREAM.identity, event: makeEvent({
          id: `revoke-lifecycle-${change.requestId}-${i}`,
          type: ROLE_REVOKED,
          occurredAt: at,
          idempotencyKey: `revoke-${tenantId}-lifecycle-${change.requestId}-${i}`,
          source: 'api/identity',
          payload: { userId: a.userId, roleId: a.roleId, branchScope: a.branchScope, provenance },
        }) })),
        ...change.added.map((a, i) => ({ stream: STREAM.identity, event: makeEvent({
          id: `grant-lifecycle-${change.requestId}-${i}`,
          type: ROLE_GRANTED,
          occurredAt: at,
          idempotencyKey: `grant-${tenantId}-lifecycle-${change.requestId}-${i}`,
          source: 'api/identity',
          // The same shape every other grant records: the assignment RBAC reads, plus who asked and who approved.
          payload: {
            userId: a.userId, roleId: a.roleId, branchScope: a.branchScope,
            request: {
              grantId: `lifecycle-${change.requestId}-${i}`, userId: a.userId, roleId: a.roleId, branchScope: a.branchScope,
              requestedBy: change.requestedBy, approvedBy: change.approvedBy, requestedAt: at,
            },
            provenance,
          },
        }) })),
      ];
      if (entries.length > 0) await input.store.appendBatch(tenantId, entries);
    },
  };
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

export function riskRegisterAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): RiskRegisterDeps {
  const foldLatest = async (tenantId: string): Promise<readonly Risk[]> => {
    const all = await allOf<Risk>(input.store, tenantId, RISK_STREAM, 'RiskRecorded');
    const byId = new Map<string, Risk>();
    for (const r of all) byId.set(r.riskId, r); // later state wins (register → accept)
    return [...byId.values()];
  };
  // Latest-per-id fold for each follow-on register — a re-state supersedes (an incident closed, a
  // remediation completed), append-only underneath (hard rule #2, nothing overwritten).
  const foldControls = async (tenantId: string): Promise<readonly Control[]> => {
    const all = await allOf<Control>(input.store, tenantId, CONTROL_STREAM, 'ControlRegistered');
    const byId = new Map<string, Control>();
    for (const c of all) byId.set(c.controlId, c);
    return [...byId.values()];
  };
  const foldIncidents = async (tenantId: string): Promise<readonly Incident[]> => {
    const all = await allOf<Incident>(input.store, tenantId, INCIDENT_STREAM, 'IncidentRecorded');
    const byId = new Map<string, Incident>();
    for (const i of all) byId.set(i.incidentId, i);
    return [...byId.values()];
  };
  const foldRemediations = async (tenantId: string): Promise<readonly Remediation[]> => {
    const all = await allOf<Remediation>(input.store, tenantId, REMEDIATION_STREAM, 'RemediationRecorded');
    const byId = new Map<string, Remediation>();
    for (const r of all) byId.set(r.remediationId, r);
    return [...byId.values()];
  };
  const foldAttestations = async (tenantId: string): Promise<readonly Attestation[]> => {
    const all = await allOf<Attestation>(input.store, tenantId, ATTESTATION_STREAM, 'ControlAttested');
    const byId = new Map<string, Attestation>();
    for (const a of all) byId.set(a.attestationId, a); // immutable — the fold just collapses exact re-sends
    return [...byId.values()];
  };
  const appendKeyed = async (
    tenantId: string, stream: string, type: string, kind: string, id: string, key: string, payload: unknown,
  ): Promise<void> => {
    const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
    await input.store.append(tenantId, stream, makeEvent({
      id: `compliance-${kind}-${id}-${d}`,
      type,
      occurredAt: input.now(),
      idempotencyKey: `compliance-${kind}-${tenantId}-${id}-${d}`,
      source: 'api/compliance',
      payload: payload as Record<string, unknown>,
    }));
  };
  return {
    now: input.now,
    risks: (tenantId) => foldLatest(tenantId),
    risk: async (tenantId, riskId) => (await foldLatest(tenantId)).find((r) => r.riskId === riskId),
    recordRisk: async (tenantId, riskId, risk, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, RISK_STREAM, makeEvent({
        id: `compliance-risk-${riskId}-${d}`,
        type: 'RiskRecorded',
        occurredAt: input.now(),
        // Keyed on the risk and a digest of its state — a re-send collapses; register-then-accept is two
        // append-only facts, the fold taking the latest (hard rule #2, nothing overwritten).
        idempotencyKey: `compliance-risk-${tenantId}-${riskId}-${d}`,
        source: 'api/compliance',
        payload: risk,
      }));
    },
    controls: (tenantId) => foldControls(tenantId),
    saveControl: (tenantId, controlId, control, key) => appendKeyed(tenantId, CONTROL_STREAM, 'ControlRegistered', 'control', controlId, key, control),
    incidents: (tenantId) => foldIncidents(tenantId),
    saveIncident: (tenantId, incidentId, incident, key) => appendKeyed(tenantId, INCIDENT_STREAM, 'IncidentRecorded', 'incident', incidentId, key, incident),
    remediations: (tenantId) => foldRemediations(tenantId),
    saveRemediation: (tenantId, remediationId, remediation, key) => appendKeyed(tenantId, REMEDIATION_STREAM, 'RemediationRecorded', 'remediation', remediationId, key, remediation),
    attestations: (tenantId) => foldAttestations(tenantId),
    saveAttestation: (tenantId, attestationId, attestation, key) => appendKeyed(tenantId, ATTESTATION_STREAM, 'ControlAttested', 'attestation', attestationId, key, attestation),
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

    // Drafts (Wave 2b · PA-03): the maker's act, append-only; the checker's approval becomes the published version.
    drafts: async (tenantId, templateId) =>
      (await allOf<TemplateDraft>(input.store, tenantId, STREAM.documents, 'TemplateVersionDrafted')).filter((d) => d.templateId === templateId),
    recordDraft: async (tenantId, draft) => {
      await input.store.append(tenantId, STREAM.documents, makeEvent({
        id: `doc-tmpl-draft-${draft.templateId}-v${draft.version}`,
        type: 'TemplateVersionDrafted',
        occurredAt: draft.createdAt,
        idempotencyKey: `doc-tmpl-draft-${tenantId}-${draft.templateId}-v${draft.version}`,
        source: 'api/platform',
        payload: draft,
      }));
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

    /** EVERY published version for the tenant — the whole `TemplateVersionPublished` fold, for retention. */
    allVersions: async (tenantId) => allOf<TemplateVersion>(input.store, tenantId, STREAM.documents, 'TemplateVersionPublished'),

    /** EVERY issued document for the tenant — the whole `DocumentIssued` fold, for retention. */
    allIssued: async (tenantId) => allOf<IssuedDocument>(input.store, tenantId, STREAM.documents, 'DocumentIssued'),

    /** Every recorded disposal decision — the append-only `DocumentDisposed` fold (M31, hard rule #6). */
    disposals: async (tenantId) => allOf<DocumentDisposal>(input.store, tenantId, STREAM.documents, 'DocumentDisposed'),

    /** Record a disposal decision, append-only. Idempotent on the document id — a re-sent disposal collapses
     *  rather than double-recording, and the fact is never deleted (hard rule #6). */
    recordDisposal: async (tenantId, disposal: DocumentDisposal) => {
      await input.store.append(tenantId, STREAM.documents, makeEvent({
        id: `doc-disposed-${disposal.documentId}`,
        type: 'DocumentDisposed',
        occurredAt: input.now(), // a full ISO instant for the ledger; disposal.at carries the business day
        idempotencyKey: `doc-disposed-${tenantId}-${disposal.documentId}`,
        source: 'api/platform',
        payload: disposal,
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
 * Quotation lifecycle store (M12-FR-02 / M22). Each state change (issued / converted / withdrawn) is an
 * append-only `QuotationStateChanged` fact, folded latest-per-quotationId — a withdrawn or expired quotation
 * is kept, never deleted (hard rule #6), because an unconverted quote is a lost sale worth seeing. The routes
 * run the tested `@sre/suspended-sales` quotation engine over the fold; this only stores the outcome.
 */
export function quotationsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): QuotationsDeps {
  // Computed here (not at module scope) because `streamName`/its separator initialise later in this file.
  const stream = streamName(STREAM.sales, 'quotations');
  return {
    now: input.now,
    quotations: async (tenantId) => {
      const all = await allOf<Quotation>(input.store, tenantId, stream, 'QuotationStateChanged');
      const byId = new Map<string, Quotation>();
      for (const q of all) byId.set(q.quotationId, q); // later state wins
      return [...byId.values()];
    },
    record: async (tenantId, q) => {
      // Keyed on quotation + state + the timestamp of THIS transition, so each is its own fact while a
      // re-send of the same one collapses.
      const stamp = q.convertedAt ?? q.withdrawnAt ?? q.issuedAt;
      await input.store.append(tenantId, stream, makeEvent({
        id: `quote-${q.quotationId}-${q.state}-${stamp}`,
        type: 'QuotationStateChanged',
        occurredAt: input.now(),
        idempotencyKey: `quote-${tenantId}-${q.quotationId}-${q.state}-${stamp}`,
        source: 'api/pos',
        payload: q,
      }));
    },
  };
}

/** One append-only fact about the daily-brief schedule: the config was `set`, or a day was `sent`. */
interface BriefScheduleEvent {
  readonly change: 'set' | 'sent';
  readonly scheduleId: string;
  readonly at: string;
  readonly by: string;
  readonly dueAt?: readonly [number, number];
  readonly language?: BriefLanguage;
  readonly staleAfterMinutes?: number;
  readonly tradingDay?: string;
}

/**
 * Scheduled daily-brief store (M29-FR-04). The schedule config (latest `set` wins) and the days already sent
 * (every `sent`, deduped) are folded from one append-only stream — a send is a durable fact so a missed one is
 * carried, not skipped, and a day sent twice collapses to one. The routes run the tested `@sre/owner-control`
 * engine; this only stores the schedule state.
 */
export function scheduledBriefAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ScheduledBriefDeps {
  const stream = streamName(STREAM.org, 'brief-schedule');
  const SCHEDULE_ID = 'owner-daily';
  return {
    now: input.now,
    schedule: async (tenantId): Promise<StoredSchedule | undefined> => {
      const events = await allOf<BriefScheduleEvent>(input.store, tenantId, stream, 'BriefSchedule');
      let config: { dueAt: readonly [number, number]; language?: BriefLanguage; staleAfterMinutes?: number } | undefined;
      const sent = new Set<string>();
      // EA-07: the first day a brief is owed is the day the schedule was first set.
      const since = events.find((e) => e.change === 'set')?.at;
      for (const e of events) {
        if (e.change === 'set' && e.dueAt !== undefined) {
          config = { dueAt: e.dueAt, ...(e.language !== undefined ? { language: e.language } : {}), ...(e.staleAfterMinutes !== undefined ? { staleAfterMinutes: e.staleAfterMinutes } : {}) };
        } else if (e.change === 'sent' && e.tradingDay !== undefined) {
          sent.add(e.tradingDay);
        }
      }
      if (config === undefined) return undefined;
      return { scheduleId: SCHEDULE_ID, dueAt: config.dueAt, sentDays: [...sent].sort(), ...(since === undefined ? {} : { since }), ...(config.language !== undefined ? { language: config.language } : {}), ...(config.staleAfterMinutes !== undefined ? { staleAfterMinutes: config.staleAfterMinutes } : {}) };
    },
    setSchedule: async (tenantId, cfg, by, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, stream, makeEvent({
        id: `brief-set-${d}`,
        type: 'BriefSchedule',
        occurredAt: input.now(),
        idempotencyKey: `brief-set-${tenantId}-${d}`,
        source: 'api/reporting',
        payload: { change: 'set', scheduleId: SCHEDULE_ID, at: input.now(), by, dueAt: cfg.dueAt, ...(cfg.language !== undefined ? { language: cfg.language } : {}), ...(cfg.staleAfterMinutes !== undefined ? { staleAfterMinutes: cfg.staleAfterMinutes } : {}) } satisfies BriefScheduleEvent,
      }));
    },
    recordSent: async (tenantId, tradingDay, by) => {
      // Keyed on the tenant + day (no timestamp), so the same day sent twice collapses to one send.
      await input.store.append(tenantId, stream, makeEvent({
        id: `brief-sent-${tenantId}-${tradingDay}`,
        type: 'BriefSchedule',
        occurredAt: input.now(),
        idempotencyKey: `brief-sent-${tenantId}-${tradingDay}`,
        source: 'api/reporting',
        payload: { change: 'sent', scheduleId: SCHEDULE_ID, at: input.now(), by, tradingDay } satisfies BriefScheduleEvent,
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
        id: keyedEventId('payrun', `payrun-${tenantId}-${payRunId}-${event.kind}-${actor}-${at}`),
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
        id: keyedEventId('gstr1sub', `gstr1sub-${tenantId}-${period}-${event.kind}-${actor}-${at}`),
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
            ...frozenCessOf(line), // Till bill and GST (A7)
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
            ...frozenCessOf(o), // Till bill and GST (A7): a return reverses the cess it was sold with
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

export function streamName(...parts: readonly string[]): string {
  for (const part of parts) {
    if (part.includes(PART)) {
      // Refused rather than stripped: a stripped separator is a silently different stream, which
      // is the failure this exists to prevent rather than a smaller version of it.
      throw new RangeError('a stream name part may not contain the unit separator');
    }
  }
  return parts.join(PART);
}

/** Round 7 (GT-05/OB-44): the register of what a migration load opened — written in the same atomic write as each item. */
const openingItemsStream = (loadId: string): string => streamName(STREAM.migration, 'opening-items', loadId);
function openingItemEntry(tenantId: string, item: OpeningItem, at: string): BatchEntry {
  const ref = item.domain === 'stored_value' ? item.instrumentId : item.domain === 'receivable' ? `${item.customerId}/${item.invoiceId}` : item.customerId;
  return { stream: openingItemsStream(item.loadId), event: makeEvent({ id: `opening-item-${item.loadId}-${item.domain}-${ref}`, type: 'OpeningItemRecorded', occurredAt: at, idempotencyKey: `opening-item-${tenantId}-${item.loadId}-${item.domain}-${ref}`, source: 'api/migration', payload: item }) };
}

/** Where a shop's subscription (plan) is recorded — read by the operator's shop list (OB-15-d-3) as head office writes it. */
export const PLATFORM_BILLING_STREAM = streamName(STREAM.platform, 'billing');

const forCustomer = (customerId: string): string => streamName(STREAM.consent, customerId);
// Data-subject requests are TENANT-WIDE (one stream, every request) so the overdue read sees the whole
// privacy queue in one fold — the queue a regulator asks about first (M20-FR-04 / DPDP).
const DATA_REQUESTS_STREAM = streamName(STREAM.consent, 'data-requests');
// Privacy EXECUTION sub-streams (M20-FR-04), all tenant-wide and append-only: the located-PII holdings, the
// checker's erasure approvals, the sealed PII-free tombstones, and the processor-erasure notices enqueued.
const PII_STREAM = streamName(STREAM.privacy, 'pii');
const ERASURE_APPROVAL_STREAM = streamName(STREAM.privacy, 'approvals');
const TOMBSTONE_STREAM = streamName(STREAM.privacy, 'tombstones');
const PRIVACY_NOTICE_STREAM = streamName(STREAM.privacy, 'processor-notices');
// Risks are TENANT-WIDE (one stream, every risk) so the gate-blocking reads fold the whole register in
// one pass (M34-FR-04). A sub-stream of compliance, kept apart from obligations.
const RISK_STREAM = streamName(STREAM.compliance, 'risk');
const CONTROL_STREAM = streamName(STREAM.compliance, 'controls');
const INCIDENT_STREAM = streamName(STREAM.compliance, 'incidents');
const REMEDIATION_STREAM = streamName(STREAM.compliance, 'remediations');
const ATTESTATION_STREAM = streamName(STREAM.compliance, 'attestations');
// Service cases are TENANT-WIDE (one stream, every case) so the breached-queue read folds them in one pass
// (M21-FR-04) — the exceptions a desk must escalate rather than let age.
const SERVICE_CASE_STREAM = streamName(STREAM.service, 'cases');
// Compensations are a ledger of money leaving the business (M21-FR-03) — append-only, on their own stream.
const SERVICE_COMPENSATION_STREAM = streamName(STREAM.service, 'compensation');
// AI drafts and the human decisions on them (P-05) — one stream, two event types.
const SERVICE_DRAFT_STREAM = streamName(STREAM.service, 'drafts');
// CSAT scores — tenant-wide, append-only (a customer rates a resolved case; the report folds them).
const SERVICE_CSAT_STREAM = streamName(STREAM.service, 'csat');
// The tenant's compensation authority limits (M21-FR-03) — tenant-wide config, append-only (latest wins).
const SERVICE_POLICY_STREAM = streamName(STREAM.service, 'compensation-policy');
// The campaign-decision log — tenant-wide, append-only (who ran which campaign, to how many, excluding
// how many and why). Counts only; the recipient lists are not stored (PRV).
const CAMPAIGN_PLAN_STREAM = streamName(STREAM.service, 'campaign-plans');
/** Points hang off the customer they belong to, so one customer's balance folds one stream. */
const forCustomerPoints = (customerId: string): string => streamName(STREAM.loyalty, customerId);
/** Each stored-value instrument's movements fold one stream; the issued-instruments index is its own. */
const forInstrument = (instrumentId: string): string => streamName(STREAM.loyalty, 'value', instrumentId);
const STORED_VALUE_INDEX = streamName(STREAM.loyalty, 'instruments');
const forDriverRun = (driverId: string, runDate: string): string =>
  streamName(STREAM.delivery, driverId, runDate);
// Packing & dispatch fold per order (M19-FR-02): one stream per order for its pack, one for its manifest.
const forOrderPack = (orderId: string): string => streamName(STREAM.delivery, 'pack', orderId);
const forOrderManifest = (orderId: string): string => streamName(STREAM.delivery, 'manifest', orderId);
const forLocation = (locationId: string): string => streamName(STREAM.reservations, locationId);
/** Each order's lifecycle folds one stream — one order's history end-to-end, not the whole shop's. */
const forOrder = (orderId: string): string => streamName(STREAM.orders, orderId);
/** A tenant-wide INDEX of substitution decisions, appended beside the per-order stream so the
 *  substitution exception worklist (M19-FR-01) can be folded shop-wide without walking every order.
 *  The per-order `forOrder` stream stays the book of record; this is a read model, exactly as the
 *  returns/e-invoice indexes keep a tenant-wide projection beside the per-aggregate stream. */
const forSubstitutionIndex = streamName(STREAM.orders, 'substitutions');
// Tenant-wide indexes for the money worklist (M18-FR-04): every payment and every refund, so "what is waiting on a bank"
// folds without walking every order — the same shape as the substitution index above.
const forPaymentIndex = streamName(STREAM.orders, 'payments');
const forRefundIndex = streamName(STREAM.orders, 'refunds');
// The storefront (M20): one index per customer of the orders they placed, and the register of refused attempts to
// read or place against another customer's order (hard rule #6).
const forCustomerOrders = (customerRef: string): string => streamName(STREAM.orders, 'customer', customerRef);
const forStorefrontRefusals = streamName(STREAM.orders, 'access-refusals');
// SF-10 · M30-FR-02: a tenant-wide INDEX of placed orders (desk and storefront alike), appended beside each order's own
// stream — the same shape as the customer index — so the governed export folds every order without walking unknown ids.
const forOrderIndex = streamName(STREAM.orders, 'index');
// M19-FR-01 / Item 2: the kept ownership state of substitution exceptions — latest per exception id.
const forExceptionOwnership = streamName(STREAM.orders, 'substitution-exception-ownership');
/**
 * SF-10 · M30-FR-02: every placed order with its CURRENT state — the order index, each order folded exactly as
 * `GET /v1/orders/:orderId` folds it (the placed record plus its last transition). A read; it writes nothing.
 */
export async function ordersForExport(store: EventStore, tenantId: string): Promise<readonly (PlacedOrder & { readonly currentState: string })[]> {
  const placed = await allOf<PlacedOrder>(store, tenantId, forOrderIndex, 'OrderPlaced');
  const out: (PlacedOrder & { readonly currentState: string })[] = [];
  for (const o of placed) {
    const transitions = await allOf<OrderTransition>(store, tenantId, forOrder(o.orderId), 'OrderTransitioned');
    out.push({ ...o, currentState: transitions.at(-1)?.to ?? o.state });
  }
  return out;
}

/** SP-7a: every captured supplier invoice, on one register — the record the match, the payable and the statement read. */
const SUPPLIER_INVOICES_STREAM = streamName(STREAM.purchase, 'invoices');
// SP-7b: the tenant's three-way-match tolerances — the owner's, latest wins, every version on the ledger.
const MATCH_POLICY_STREAM = streamName(STREAM.purchase, 'match-policy');
// SP-7c: the supplier MASTER (versioned records, latest wins), the payments recorded against suppliers, and the debit notes
// issued under a number — three tenant-wide registers (a shop has hundreds of suppliers, not hundreds of thousands).
const SUPPLIERS_STREAM = streamName(STREAM.purchase, 'suppliers');
const SUPPLIER_PAYMENTS_STREAM = streamName(STREAM.purchase, 'supplier-payments');
const DEBIT_NOTE_ISSUES_STREAM = streamName(STREAM.purchase, 'debit-note-issues');
/** GT-05 — opening supplier balances carried from the old system, and the second person's sign-off of each load. */
const SUPPLIER_OPENINGS_STREAM = streamName(STREAM.purchase, 'supplier-openings');
/** Each supplier partner's portal config and submissions fold one stream — one partner, not the shop. */
const forPortalPartner = (partnerId: string): string => streamName(STREAM.purchase, 'partner', partnerId);
/** SF-09: the ASNs a buyer accepted from the supplier portal — the register the ASN compare reads. */
const ASN_REGISTER_STREAM = streamName(STREAM.purchase, 'asns');
/** SF-09: an accepted ASN by its id (the latest record wins; an ASN is accepted once). */
export async function acceptedAsn(store: EventStore, tenantId: string, asnId: string): Promise<Asn | undefined> {
  const all = await allOf<Asn>(store, tenantId, ASN_REGISTER_STREAM, 'AsnAccepted');
  return all.filter((a) => a.asnId === asnId).at(-1);
}
// Partner-action audit is TENANT-WIDE (one stream, every partner) so `findProbing` can see a supplier
// trying doors across the shop — the whole point is a view no single partner's stream would give (M24-FR-04).
const PORTAL_AUDIT_STREAM = streamName(STREAM.purchase, 'portal-audit');
// A supplier login's binding to its partner (M24-FR-01, §35) — keyed by the USER, so a supplier-facing
// read resolves its partner id from the session, never the request. Latest binding wins (a login moved to
// a different partner re-points); the stream folds one user, not the shop.
const forPortalLogin = (userId: string): string => streamName(STREAM.purchase, 'portal-login', userId);
// M22-FR-04: the B2B customer portal — a login's binding (latest wins), a customer's login index, and the refusal register.
const forB2BPortalLogin = (userId: string): string => streamName(STREAM.b2b, 'portal-login', userId);
const forB2BPortalLogins = (customerId: string): string => streamName(STREAM.b2b, 'portal-logins', customerId);
const forB2BPortalRefusals = streamName(STREAM.b2b, 'portal-refusals');
// Purchase orders and supplier holds live on their own shared streams so a fold can list every PO
// (and answer the open commitment) and read a supplier's latest block state (M06-FR-01/02/04).
const PURCHASE_ORDERS_STREAM = streamName(STREAM.purchase, 'orders');
const SUPPLIER_BLOCK_STREAM = streamName(STREAM.purchase, 'supplier-block');
// Supplier performance: delivery outcomes per supplier (scored), contracts on one shared stream (reviewed).
const forSupplierPerformance = (supplierId: string): string => streamName(STREAM.purchase, 'performance', supplierId);
const SUPPLIER_CONTRACTS_STREAM = streamName(STREAM.purchase, 'contracts');
// Rebates: schemes on one shared stream (latest per id); accruals on a per-scheme stream (latest per accrual id).
const REBATE_SCHEMES_STREAM = streamName(STREAM.purchase, 'rebate-schemes');
const forRebateAccruals = (schemeId: string): string => streamName(STREAM.purchase, 'rebate', schemeId);
// RFQ: requisitions on one shared stream (latest per id); quotes on a per-requisition stream (latest per quote id).
const REQUISITIONS_STREAM = streamName(STREAM.purchase, 'requisitions');
// Import job history (M30-FR-04): every recorded job outcome on one shared stream, latest per jobId.
const IMPORT_JOBS_STREAM = streamName(STREAM.purchase, 'import-jobs');
const forRfqQuotes = (requisitionId: string): string => streamName(STREAM.purchase, 'rfq', requisitionId);
/** Returns hang off the sale they are against, so "what came back on this bill?" reads one stream. */
const forSaleReturns = (saleId: string): string => streamName(STREAM.sales, 'return', saleId);
/** Each till's cash chain folds one stream — its balance and custodian read one till, not the shop. Before OB-80: by the till alone. */
const forTillCash = (tillId: string): string => streamName(STREAM.cash, tillId);
/** OB-80 "A": a till is (store, till) — its chain is that store's till's own stream. */
const forStoreTillCash = (storeId: string, tillId: string): string => streamName(STREAM.cash, 'at', storeId, tillId);
/** OB-80: which tills head office has kept cash for at each store (one entry per (store, till), append-only). */
const forTillsAtStore = (storeId: string): string => streamName(STREAM.cash, 'tills-at', storeId);
/** Shift closes share one stream (low-volume — a few tills × shifts a day), folded by shift id. */
const SHIFTS_STREAM = streamName(STREAM.cash, 'shifts');
/**
 * Store/day closes and reopens (M14-FR-04) — their own cash-office stream, folded by day-close id.
 * Deliberately NOT `STREAM.periods`: that stream is the finance monthly period close (M23-FR-04),
 * which folds `PeriodClosed`/`PeriodReopened` keyed by `YYYY-MM`; the store day close is a distinct
 * fact keyed by `dayCloseId`, so it keeps its own stream and its own event types to avoid a phantom
 * period leaking into the finance close.
 */
const DAY_CLOSE_STREAM = streamName(STREAM.cash, 'day-close');
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
/** The till's docket tags for a contract — every version appended, the standing one folded (M27-FR-03). */
const forConcessionTags = (contractId: string): string => streamName(STREAM.concession, 'tags', contractId);
/** Every contract ever defined, by partner — so a synced docket line that names only the partner finds its contract. */
const CONCESSION_CONTRACT_INDEX = streamName(STREAM.concession, 'contracts', 'index');
async function latestConcessionTags(store: EventStore, tenantId: string, contractId: string): Promise<readonly ConcessionTag[]> {
  return latestTagVersions(await allOf<ConcessionTag>(store, tenantId, forConcessionTags(contractId), 'ConcessionTagRecorded'));
}
// A concessionaire's deposit movements — the deposit position is projected from these (a liability).
const forConcessionaire = (concessionaireId: string): string => streamName(STREAM.concession, 'deposit', concessionaireId);
/** Each packaging item's registration and movements fold one stream — one item, not every crate. */
const forPackaging = (packagingId: string): string => streamName(STREAM.packaging, packagingId);
/** Each webhook provider's config and processed deliveries fold one stream — one provider, not all. */
const forWebhook = (provider: string): string => streamName(STREAM.integration, 'webhook', provider);
/** Each connector mapping version folds one stream — one (connector, version), not every mapping. */
const forConnectorMapping = (connectorId: string, version: string): string => streamName(STREAM.integration, 'mapping', connectorId, version);
/** Each connector's delivery queue folds its own stream — the enqueue/deliver/fail log for that connector. */
const forConnectorDelivery = (connectorId: string): string => streamName(STREAM.integration, 'delivery', connectorId);
/**
 * A tenant-wide index of the connectors ever mapped or written to (M35-FR-03): connector queues live on
 * per-connector streams, which nothing can enumerate, so the first mapping or delivery on a connector also
 * appends one `ConnectorSeen` fact here — idempotent on the connector id, so it lands once.
 */
async function indexConnector(store: EventStore, tenantId: string, connectorId: string, at: string): Promise<void> {
  await store.append(tenantId, STREAM.integration, makeEvent({
    id: `conn-seen-${connectorId}`,
    type: 'ConnectorSeen',
    occurredAt: at,
    idempotencyKey: `conn-seen-${tenantId}-${connectorId}`,
    source: 'api/platform',
    payload: { connectorId, firstSeenAt: at },
  }));
}
// Managed secret references (M32-FR-03) live on one shared stream — the latest state per secret id.
const SECRETS_STREAM = streamName(STREAM.integration, 'secrets');
// The domain-level audit trail (M34-FR-01) — one tenant-wide append-only chain of sealed records.
const AUDIT_TRAIL_STREAM = streamName(STREAM.audit, 'domain-trail');
// Org structure (M01-FR-01): nodes on one shared stream (latest per node id), GST registrations on another.
const ORG_NODES_STREAM = streamName(STREAM.org, 'nodes');
const ORG_REGISTRATIONS_STREAM = streamName(STREAM.org, 'gst-registrations');
// Shelf counts are per store — append-only observations (a recount is a new row, M04-FR-02/03).
const forShelfCounts = (storeId: string): string => streamName(STREAM.inventory, 'shelf-count', storeId);
// Display contracts are tenant-wide (the owner reviews them all; the review filters by store) — append-only,
// folded latest-per-contractId so a correction supersedes.
const DISPLAY_CONTRACT_STREAM = streamName(STREAM.inventory, 'display-contracts');
// Range decisions are per store, append-only and effective-dated — the reads fold them into an Assortment.
const forAssortment = (storeId: string): string => streamName(STREAM.inventory, 'assortment', storeId);
// Approval delegations are tenant-wide, append-only, folded latest-per-delegationId (a revocation supersedes).
const DELEGATION_STREAM = streamName(STREAM.identity, 'delegations');
const EMERGENCY_ACCESS_STREAM = streamName(STREAM.identity, 'emergency-access');
// The owner drill audit — who reached which transactions (§28). Tenant-wide, append-only, never folded.
const DRILL_AUDIT_STREAM = streamName(STREAM.platform, 'drill-audits');
// The DR-drill register — every recovery rehearsal scored + kept as §32 evidence (M35-FR-02). Distinct from
// the owner drill audit above; append-only, a missed drill kept (hard rule #6).
const DR_DRILLS_STREAM = streamName(STREAM.platform, 'dr-drills');

/**
 * The durable DR-drill register (M35-FR-02) — the stateful counterpart to the stateless dr-drills/score ruling.
 * A recorded drill is scored on the SAME tested engine at the route, then kept here append-only; the register
 * read folds every drill, a miss included, so the §32 "evidence over N quarters" can finally be shown.
 */
export function drReadinessAdapter(input: { readonly store: EventStore; readonly now: () => string }): DrReadinessDeps {
  return {
    now: input.now,
    drills: (tenantId) => allOf<DrDrillRecord>(input.store, tenantId, DR_DRILLS_STREAM, 'DrDrillRecorded'),
    recordDrill: async (tenantId, record) => {
      await input.store.append(tenantId, DR_DRILLS_STREAM, makeEvent({
        id: keyedEventId('dr-drill', `dr-drill-${tenantId}-${record.drillId}-${record.drilledAt}`),
        type: 'DrDrillRecorded',
        occurredAt: record.drilledAt,
        idempotencyKey: `dr-drill-${tenantId}-${record.drillId}-${record.drilledAt}`,
        source: 'api/platform',
        payload: record,
      }));
    },
  };
}
/** Each pay run's lifecycle folds one stream — one run's history (drafted→…→locked), not the whole shop's. */
const forPayRun = (payRunId: string): string => streamName(STREAM.payroll, payRunId);
/** Each filing period's GSTR-1 submission folds one stream — one period's preview→approve→file history. */
const forGstr1Submission = (period: string): string => streamName(STREAM.gstreturns, 'submission', period);
/** A tenant-wide index of the periods that have a submission — the exception queue folds each one. */
const GSTR1_SUBMISSION_INDEX = streamName(STREAM.gstreturns, 'submission-index');

/** The tenant's durable roster — one stream for the staff directory, shifts and assignments (latest-per-id). */
const ROSTER_STREAM = streamName(STREAM.workforce, 'roster');

/**
 * An event id that follows its idempotency key — one id per key. An id built from a clock instead let two different facts
 * written in the same millisecond share one id under two keys: the ledger's unique event id refuses the second (a named
 * clash since round 12; a raw 500 on PostgreSQL before), so the second fact was lost. With the id derived from the key,
 * the same fact again is the same id and key (a dedup) and a different fact is a different id.
 */
function keyedEventId(prefix: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/**
 * Which earlier events on the stream are the SAME setting (e.g. the same rule kind, the same asset) and that subject's key —
 * absent: every event of the type is one setting. Verifier r20 SET-2: the key names the subject's own write guard.
 */
type SettingSubject =
  | { readonly sameSubject?: undefined; readonly subjectKey?: undefined }
  | { readonly sameSubject: (payload: unknown) => boolean; readonly subjectKey: string };

/**
 * Hard rule #10 · verifier r18 RULE10-ABA — a SETTING (a policy, a threshold, a rule, a limit) set back to an earlier
 * value must be in force. These settings used to be keyed on their VALUE alone, so A → B → A collapsed the second A onto
 * the first: the owner was told "saved" and B stayed in force. Now a setting's key is its value AND the setting it
 * supersedes (the latest one in force for the same subject): re-sending the value already in force writes nothing (as
 * before — a true replay, or a crash-retry of one, dedupes), while a change back to an earlier value is a new, latest fact.
 * Two writers setting the same value over the same predecessor meet on one key and collapse to one event.
 */
async function appendSetting(store: EventStore, tenantId: string, stream: string, s: SettingSubject & {
  readonly type: string;
  /** The event id's prefix (the id follows the key, so two different settings never clash on one id). */
  readonly idPrefix: string;
  /** The value's key, as it was before (tenant + subject + value): kept for the first setting, so old ledgers read the same. */
  readonly valueKey: string;
  readonly occurredAt: string;
  readonly source: string;
  readonly payload: object;
  /** Whether the setting in force already holds this value (the fields the value key names). */
  readonly sameValue: (payload: unknown) => boolean;
}): Promise<void> {
  // Verifier r19 SET-1 (hard rule #10): two DIFFERENT values for the same setting at the same moment both answered "saved"
  // and one was silently lost. Now each setting writes under a write guard: the writer reads the guard, then the setting in
  // force, and its append lands only while the guard still holds. A writer that lost the race re-reads: the SAME value
  // landed at the same moment → one fact, saved; a DIFFERENT value landed → a visible 409 "changed at the same moment",
  // never a silent loss.
  // Verifier r20 SET-2: the guard is the SUBJECT's own (family + subject key) — saves to DIFFERENT items of one family (ten
  // production costs, forty invoice matches at once) never meet on one guard, so none is refused for another's save. A
  // setting with no subjects (one per family) keeps the family guard: the family IS the subject.
  const guardKey = s.subjectKey === undefined ? `setting:${stream}:${s.type}` : `setting:${stream}:${s.type}:${s.subjectKey}`;
  const latestOf = async (): Promise<PersistedEvent | undefined> =>
    (await store.readStream(tenantId, stream, { type: s.type })).filter((e) => s.sameSubject?.(e.event.payload) ?? true).at(-1);
  for (let attempt = 0; ; attempt += 1) {
    const expectedVersion = await store.guardVersion(tenantId, guardKey);
    const prior = await latestOf();
    if (prior !== undefined && s.sameValue(prior.event.payload)) return;
    const key = prior === undefined ? s.valueKey : `${s.valueKey}-after-${prior.event.id}`;
    try {
      await store.appendBatch(tenantId, [{ stream, event: makeEvent({
        id: keyedEventId(s.idPrefix, key), type: s.type, occurredAt: s.occurredAt, idempotencyKey: key, source: s.source, payload: s.payload,
      }) }], { guard: { key: guardKey, expectedVersion } });
      return;
    } catch (e) {
      if (!(e instanceof ConcurrencyConflictError) || e.key !== guardKey) throw e;
      const now = await latestOf();
      // The same value landed at the same moment: the two requests are one fact, and it is in force.
      if (now !== undefined && s.sameValue(now.event.payload)) return;
      // The guard moved but this setting reads unchanged (a write that has not become visible yet): try again, a few times.
      if (now?.event.id === prior?.event.id) {
        if (attempt < 8) continue;
        // Verifier r20 SET-2: still unchanged after every try — head office was busy, nobody changed THIS setting. Said so.
        throw apiError(409, {
          code: 'setting_busy_try_again',
          whatHappened: 'Head office was busy saving other changes at the same moment and could not save this one. Nobody else changed this setting; yours was not saved.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Save it again in a moment. Nothing else was changed.',
        });
      }
      throw apiError(409, {
        code: 'setting_changed_at_the_same_moment',
        whatHappened: 'Somebody else changed this same setting at the same moment, to a different value. Their value is the one head office kept; yours was not saved.',
        wasItSaved: 'not_saved',
        nextSafeAction: 'Read the setting again to see the value in force, then set it again if yours is the one wanted. Nothing else was changed.',
      });
    }
  }
}

/**
 * The durable roster store (M25-FR-01 follow-on). The workforce DECISION routes are stateless what-ifs; this
 * makes the roster durable — the staff directory, shifts and assignments each append to one tenant stream and
 * "current" is a latest-per-id fold of the stored facts (hard rule #2), so a restart never loses who is on.
 */
export function rosterStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<RosterStoreDeps, 'staffVisibility'> {
  const append = async (tenantId: string, type: string, id: string, key: string, payload: object): Promise<void> => {
    await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
      id: keyedEventId(`${type}-${id}`, key),
      type,
      occurredAt: input.now(),
      idempotencyKey: key,
      source: 'api/hr',
      payload,
    }));
  };
  return {
    now: input.now,
    putEmployee: (tenantId, employee, key) => append(tenantId, 'RosterEmployeeSet', employee.employeeId, key, employee),
    putShift: (tenantId, shift, key) => append(tenantId, 'RosterShiftSet', shift.shiftId, key, shift),
    putAssignment: (tenantId, assignment, key) => append(tenantId, 'RosterAssignmentSet', `${assignment.shiftId}:${assignment.employeeId}`, key, assignment),
    roster: async (tenantId, branchId) => {
      // Latest-per-id: allOf returns occurrence order, so the last set of each id wins.
      const emp = new Map<string, WfEmployee>();
      for (const e of await allOf<WfEmployee>(input.store, tenantId, ROSTER_STREAM, 'RosterEmployeeSet')) emp.set(e.employeeId, e);
      const shf = new Map<string, WfShift>();
      for (const s of await allOf<WfShift>(input.store, tenantId, ROSTER_STREAM, 'RosterShiftSet')) shf.set(s.shiftId, s);
      const asg = new Map<string, WfAssignment>();
      for (const a of await allOf<WfAssignment>(input.store, tenantId, ROSTER_STREAM, 'RosterAssignmentSet')) asg.set(`${a.shiftId}:${a.employeeId}`, a);

      let employees = [...emp.values()];
      let shifts = [...shf.values()];
      let assignments = [...asg.values()];
      if (branchId !== undefined) {
        employees = employees.filter((x) => x.branchId === branchId);
        shifts = shifts.filter((x) => x.branchId === branchId);
        const shiftIds = new Set(shifts.map((s) => s.shiftId));
        assignments = assignments.filter((a) => shiftIds.has(a.shiftId));
      }
      return { employees, shifts, assignments };
    },
  };
}

/**
 * The durable certification store (M25-FR-03 follow-on). Certificates append to the SAME tenant `workforce`
 * stream as the roster (event type distinguishes them), latest-per-certificationId; the stateful task-gate
 * reads a stored employee (the roster fold) + their certificates and runs the tested `canPerformTask`.
 */
export function certStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): CertStoreDeps {
  const latestCerts = async (tenantId: string): Promise<WfCertification[]> => {
    const byId = new Map<string, WfCertification>();
    for (const c of await allOf<WfCertification>(input.store, tenantId, ROSTER_STREAM, 'RosterCertificationSet')) byId.set(c.certificationId, c);
    return [...byId.values()];
  };
  return {
    now: input.now,
    putCertification: async (tenantId, cert, key) => {
      await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
        id: keyedEventId(`RosterCertificationSet-${cert.certificationId}`, key),
        type: 'RosterCertificationSet',
        occurredAt: input.now(),
        idempotencyKey: key,
        source: 'api/hr',
        payload: cert,
      }));
    },
    certifications: async (tenantId, employeeId) => {
      const all = await latestCerts(tenantId);
      return employeeId === undefined ? all : all.filter((c) => c.employeeId === employeeId);
    },
    employee: async (tenantId, employeeId) => {
      // Latest-per-id over the roster's employee events (the same fold the roster store uses).
      let found: WfEmployee | undefined;
      for (const e of await allOf<WfEmployee>(input.store, tenantId, ROSTER_STREAM, 'RosterEmployeeSet')) {
        if (e.employeeId === employeeId) found = e; // occurrence order → last wins
      }
      return found;
    },
  };
}

/**
 * The durable SOP-acknowledgement store (M25-FR-04 follow-on). SOPs and acknowledgements append to the SAME
 * tenant `workforce` stream, latest-per-id; the stateful sop-status reads a stored employee (the roster fold) +
 * the SOPs for their role + their acknowledgements and runs the tested `sopStatus`.
 */
export function sopStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): SopStoreDeps {
  return {
    now: input.now,
    putSop: async (tenantId, sop, key) => {
      await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
        id: keyedEventId(`SopDefinitionSet-${sop.sopId}`, key),
        type: 'SopDefinitionSet', occurredAt: input.now(), idempotencyKey: key, source: 'api/hr', payload: sop,
      }));
    },
    putAcknowledgement: async (tenantId, ack, key) => {
      await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
        id: keyedEventId(`SopAcknowledgedSet-${ack.sopId}-${ack.employeeId}`, key),
        type: 'SopAcknowledgedSet', occurredAt: input.now(), idempotencyKey: key, source: 'api/hr', payload: ack,
      }));
    },
    sops: async (tenantId) => {
      const byId = new Map<string, WfSop>();
      for (const s of await allOf<WfSop>(input.store, tenantId, ROSTER_STREAM, 'SopDefinitionSet')) byId.set(s.sopId, s);
      return [...byId.values()];
    },
    acknowledgements: async (tenantId, employeeId) => {
      // Latest acknowledgement per (sopId, employeeId) — a re-ack when a version bumps replaces the prior one.
      const byKey = new Map<string, WfSopAck>();
      for (const a of await allOf<WfSopAck>(input.store, tenantId, ROSTER_STREAM, 'SopAcknowledgedSet')) byKey.set(`${a.sopId}:${a.employeeId}`, a);
      const all = [...byKey.values()];
      return employeeId === undefined ? all : all.filter((a) => a.employeeId === employeeId);
    },
    employee: async (tenantId, employeeId) => {
      let found: WfEmployee | undefined;
      for (const e of await allOf<WfEmployee>(input.store, tenantId, ROSTER_STREAM, 'RosterEmployeeSet')) {
        if (e.employeeId === employeeId) found = e; // occurrence order → last wins
      }
      return found;
    },
  };
}

/**
 * The durable attendance store (M25 follow-on). Hours-worked records append to the SAME tenant `workforce`
 * stream, latest-per-(employee,date); the stateful labour-cost view reads the stored hours for a day + the
 * stored staff for a branch and runs the tested `labourCost` (reported, never enforced).
 */
export function attendanceStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): AttendanceStoreDeps {
  return {
    now: input.now,
    putAttendance: async (tenantId, record, key) => {
      await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
        // The id follows the idempotency key (one event per key): a timestamp alone let two corrections in the same
        // millisecond share an id under different keys — a clash the ledger refuses (hard rule #10), not a correction.
        id: keyedEventId(`AttendanceSet-${record.employeeId}-${record.date}`, key),
        type: 'AttendanceSet', occurredAt: input.now(), idempotencyKey: key, source: 'api/hr', payload: record,
      }));
    },
    attendance: async (tenantId, date) => {
      // Latest hours per (employee, date); return the rows for the requested day.
      const byKey = new Map<string, WfAttendance>();
      for (const r of await allOf<WfAttendance>(input.store, tenantId, ROSTER_STREAM, 'AttendanceSet')) byKey.set(`${r.employeeId}:${r.date}`, r);
      return [...byKey.values()].filter((r) => r.date === date);
    },
    employees: async (tenantId, branchId) => {
      const byId = new Map<string, WfEmployee>();
      for (const e of await allOf<WfEmployee>(input.store, tenantId, ROSTER_STREAM, 'RosterEmployeeSet')) byId.set(e.employeeId, e);
      const all = [...byId.values()];
      return branchId === undefined ? all : all.filter((e) => e.branchId === branchId);
    },
  };
}

/**
 * The durable checklist-completion store (M25-FR-02 follow-on). A submitted opening/closing/handover checklist
 * appends to the SAME tenant `workforce` stream, latest-per-checklistId (a re-submission supersedes; the prior
 * events are kept, hard rule #6); the stateful assessment reads the stored checklist and runs the tested
 * `assessChecklist`, so a checklist can be produced and re-assessed weeks later, not only in the moment it was
 * ticked.
 */
export function checklistStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): ChecklistStoreDeps {
  return {
    now: input.now,
    putChecklist: async (tenantId, checklist, key) => {
      await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
        id: keyedEventId(`ChecklistSubmittedSet-${checklist.checklistId}`, key),
        type: 'ChecklistSubmittedSet', occurredAt: input.now(), idempotencyKey: key, source: 'api/hr', payload: checklist,
      }));
    },
    checklists: async (tenantId) => {
      // Latest submission per checklistId — a re-submission of the same checklist replaces the prior one.
      const byId = new Map<string, WfChecklist>();
      for (const c of await allOf<WfChecklist>(input.store, tenantId, ROSTER_STREAM, 'ChecklistSubmittedSet')) byId.set(c.checklistId, c);
      return [...byId.values()];
    },
    checklist: async (tenantId, checklistId) => {
      let found: WfChecklist | undefined;
      for (const c of await allOf<WfChecklist>(input.store, tenantId, ROSTER_STREAM, 'ChecklistSubmittedSet')) {
        if (c.checklistId === checklistId) found = c; // occurrence order → last wins
      }
      return found;
    },
  };
}

/**
 * The durable daily-task routing + escalation store (M25-FR-02). A task DEFINITION and its COMPLETION append to
 * the SAME tenant `workforce` stream, latest-per-taskId; the routed task list folds a task's definition with
 * whether a completion exists (done/doneBy/doneAt merged in) and the tested `assessDailyTasks` decides pending /
 * overdue / escalated — an overdue CRITICAL task escalates to the manager on duty (P-03).
 */
export function taskStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): TaskStoreDeps {
  return {
    now: input.now,
    putTask: async (tenantId, def, key) => {
      await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
        id: keyedEventId(`DailyTaskSet-${def.taskId}`, key),
        type: 'DailyTaskSet', occurredAt: input.now(), idempotencyKey: key, source: 'api/hr', payload: def,
      }));
    },
    completeTask: async (tenantId, completion, key) => {
      await input.store.append(tenantId, ROSTER_STREAM, makeEvent({
        id: keyedEventId(`DailyTaskCompletedSet-${completion.taskId}`, key),
        type: 'DailyTaskCompletedSet', occurredAt: input.now(), idempotencyKey: key, source: 'api/hr', payload: completion,
      }));
    },
    tasks: async (tenantId) => {
      // Latest definition per taskId, latest completion per taskId; a task is done when a completion exists.
      const defs = new Map<string, WfTaskDef>();
      for (const d of await allOf<WfTaskDef>(input.store, tenantId, ROSTER_STREAM, 'DailyTaskSet')) defs.set(d.taskId, d);
      const done = new Map<string, WfTaskDone>();
      for (const c of await allOf<WfTaskDone>(input.store, tenantId, ROSTER_STREAM, 'DailyTaskCompletedSet')) done.set(c.taskId, c);
      return [...defs.values()].map((d): WfDailyTask => {
        const c = done.get(d.taskId);
        return {
          taskId: d.taskId, description: d.description, forRole: d.forRole, dueAt: d.dueAt, critical: d.critical,
          ...(d.branchId === undefined ? {} : { branchId: d.branchId }),
          done: c !== undefined,
          ...(c === undefined ? {} : { doneBy: c.doneBy, doneAt: c.doneAt }),
        };
      });
    },
  };
}

/** Issued payslips fold one tenant stream, latest-per-(employeeId,period) — the durable ESS payslip record. */
const PAYSLIPS_STREAM = streamName(STREAM.payroll, 'payslips');

/**
 * The durable issued-payslip store (M25 · ESS). Each issued payslip appends to one tenant stream,
 * latest-per-(employeeId,period); `my-payslip` reads the caller's most-recent-period payslip and the tested
 * `employeeSelfView` redacts it. A retained record (hard rule #6) — a re-issue supersedes but never erases.
 */
export function payslipStoreAdapter(input: { readonly store: EventStore; readonly now: () => string }): PayslipStoreDeps {
  const foldFor = async (tenantId: string, employeeId: string): Promise<IssuedPayslip[]> => {
    const byPeriod = new Map<string, IssuedPayslip>();
    for (const p of await allOf<IssuedPayslip>(input.store, tenantId, PAYSLIPS_STREAM, 'PayslipIssued')) {
      if (p.employeeId === employeeId) byPeriod.set(p.period, p); // occurrence order → last issue of a period wins
    }
    return [...byPeriod.values()];
  };
  return {
    now: input.now,
    putPayslip: async (tenantId, issued, key) => {
      await input.store.append(tenantId, PAYSLIPS_STREAM, makeEvent({
        id: keyedEventId(`PayslipIssued-${issued.employeeId}-${issued.period}`, key),
        type: 'PayslipIssued', occurredAt: input.now(), idempotencyKey: key, source: 'api/hr', payload: issued,
      }));
    },
    payslipsFor: foldFor,
    latestPayslip: async (tenantId, employeeId) => {
      const all = await foldFor(tenantId, employeeId);
      if (all.length === 0) return undefined;
      return all.sort((a, b) => b.period.localeCompare(a.period))[0]; // most recent pay period
    },
  };
}

/**
 * SF-10 · M30-FR-02: every issued payslip in the shop, latest issue per (employee, period) — the SAME fold `payslipsFor`
 * runs for one person, over the whole payslip register, for the governed payroll export. A read; it writes nothing.
 */
export async function allIssuedPayslips(store: EventStore, tenantId: string): Promise<readonly IssuedPayslip[]> {
  const byKey = new Map<string, IssuedPayslip>();
  for (const p of await allOf<IssuedPayslip>(store, tenantId, PAYSLIPS_STREAM, 'PayslipIssued')) byKey.set(`${p.employeeId}|${p.period}`, p);
  return [...byKey.values()];
}

export const STREAM_FOR = { forCustomer, forDriverRun, forLocation, forSaleReturns, forOrderPack, supplierInvoices: SUPPLIER_INVOICES_STREAM } as const;

export function catalogueAdapter(input: {
  readonly store: EventStore;
  readonly signer: CatalogueDeps['signer'];
  readonly now: () => string;
  /** D-19: the owner's zone / channel switches, applied to the price entries the pack is built from (main.ts wires it). */
  readonly pricing?: CataloguePreviewDeps['pricing'];
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
        cataloguePreviewAdapter({ store: input.store, now: input.now, ...(input.pricing === undefined ? {} : { pricing: input.pricing }) }),
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
/**
 * Head office's category list (SF-06-b · OB-24 "A" · M03-FR-01): each definition is a `CategoryDefined` version on the
 * catalogue's categories stream; the list is the latest version per id (a change is a new version — hard rule #2).
 */
export const CATEGORIES_STREAM = streamName(STREAM.catalogue, 'categories');
export function categoryRegisterAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<CategoryRegisterDeps, 'approvals'> {
  return {
    now: input.now,
    categories: async (tenantId) => {
      const latest = new Map<string, StoredCategory>();
      for (const c of await allOf<StoredCategory>(input.store, tenantId, CATEGORIES_STREAM, 'CategoryDefined')) latest.set(c.categoryId, c);
      return [...latest.values()];
    },
    define: async (tenantId, records) => {
      await input.store.appendBatch(tenantId, records.map((r) => ({
        stream: CATEGORIES_STREAM,
        event: makeEvent({
          id: `category-${r.categoryId}-v${r.version}`, type: 'CategoryDefined', occurredAt: r.definedAt,
          // One version of one category, once: a re-sent definition collapses onto the first.
          idempotencyKey: `category-${tenantId}-${r.categoryId}-v${r.version}`, source: 'api/catalogue', payload: r,
        }),
      })));
    },
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
  };
}

/** The product master's stream (`ProductPublished`, latest per id). */
export const PRODUCTS_STREAM = streamName(STREAM.catalogue, 'products');

// ── Keyed catalogue indexes (GT-05 store volume) ────────────────────────────────────────────────────────────────────────
// The product publish's SKU-clash check and the barcode route's one-code-one-item check used to fold the WHOLE product
// master / barcode register on every call — ~150 ms a call at 15 000 products on PostgreSQL, quadratic over a load. Each now
// reads only the key it needs, by `latestOfType` on a per-key index stream (one indexed row):
//   • `catalogue/barcode-owner/<code>`  → the product the code names (`BarcodeOwnerIndexed`);
//   • `catalogue/sku-holder/<sku>`      → the last product to claim the SKU (`SkuClaimed`);
//   • `catalogue/product-sku/<product>` → the SKU a product is published under now (`ProductSkuIndexed`).
// A claimant holds a SKU only while its own current SKU is still that SKU, so a product that moves to a new SKU frees the
// old one without a release record. Each index entry is written in the SAME atomic batch as the record it indexes, and the
// write is GUARDED per code / per SKU (`barcode:<code>`, `sku:<sku>`): two simultaneous writers both read version v, one
// lands, the other is refused by name and re-checks — never two owners (hard rule #10). The ledger stays the only truth:
// an index entry is derived from the record beside it, appended, never updated (hard rule #2). A tenant whose catalogue was
// written before these indexes is indexed ONCE — one guarded batch, marker included — before its first keyed check, so no
// keyed check ever runs against a half-built index.
const BARCODES_STREAM = streamName(STREAM.catalogue, 'barcodes');
const barcodeOwnerStream = (code: string): string => streamName(STREAM.catalogue, 'barcode-owner', code);
const skuHolderStream = (sku: string): string => streamName(STREAM.catalogue, 'sku-holder', sku);
const productSkuStream = (productId: string): string => streamName(STREAM.catalogue, 'product-sku', productId);
const CATALOGUE_INDEX_STREAM = streamName(STREAM.catalogue, 'indexes');
interface SkuIndexed { readonly productId: string; readonly sku: string }

/** The index entries for one published product: its current SKU, and its claim on that SKU. */
function skuIndexEntries(tenantId: string, record: { readonly productId: string; readonly sku: string }, suffix: string, at: string): BatchEntry[] {
  const payload: SkuIndexed = { productId: record.productId, sku: record.sku };
  return [
    { stream: productSkuStream(record.productId), event: makeEvent({ id: `product-sku-${record.productId}-${suffix}`, type: 'ProductSkuIndexed', occurredAt: at, idempotencyKey: `product-sku-${tenantId}-${record.productId}-${suffix}`, source: 'api/catalogue', payload }) },
    { stream: skuHolderStream(record.sku), event: makeEvent({ id: `sku-claim-${record.productId}-${suffix}`, type: 'SkuClaimed', occurredAt: at, idempotencyKey: `sku-claim-${tenantId}-${record.sku}-${record.productId}-${suffix}`, source: 'api/catalogue', payload }) },
  ];
}

/** Indexes built once per tenant — remembered per process (a marker, once written, is permanent). */
const builtIndexes = new WeakMap<EventStore, Set<string>>();
/**
 * Make sure a tenant's catalogue index `name` exists: a keyed look for its marker; when absent, ONE guarded batch writes an
 * entry for every record already in the ledger AND the marker — all or nothing. A competing builder loses the guard and
 * finds the marker.
 */
async function ensureCatalogueIndex(store: EventStore, tenantId: string, name: 'barcode-owner' | 'sku', build: () => Promise<BatchEntry[]>): Promise<void> {
  const seen = builtIndexes.get(store) ?? new Set<string>();
  builtIndexes.set(store, seen);
  const markerKey = `catalogue-index-${tenantId}-${name}`;
  if (seen.has(markerKey)) return;
  for (let attempt = 0; ; attempt += 1) {
    if ((await store.findByIdempotencyKey(tenantId, markerKey)) !== undefined) { seen.add(markerKey); return; }
    const version = await store.guardVersion(tenantId, `catalogue-index:${name}`);
    const entries = await build();
    const marker: BatchEntry = { stream: CATALOGUE_INDEX_STREAM, event: makeEvent({ id: `catalogue-index-${name}`, type: 'CatalogueIndexBuilt', occurredAt: new Date().toISOString(), idempotencyKey: markerKey, source: 'api/catalogue', payload: { index: name, entries: entries.length } }) };
    try {
      await store.appendBatch(tenantId, [...entries, marker], { guard: { key: `catalogue-index:${name}`, expectedVersion: version } });
      seen.add(markerKey);
      return;
    } catch (err) {
      if (!(err instanceof ConcurrencyConflictError) || attempt >= 4) throw err;
    }
  }
}

async function ensureSkuIndex(store: EventStore, tenantId: string): Promise<void> {
  await ensureCatalogueIndex(store, tenantId, 'sku', async () => {
    const latest = new Map<string, ProductRecord>();
    for (const r of await allOf<ProductRecord>(store, tenantId, PRODUCTS_STREAM, 'ProductPublished')) latest.set(r.productId, r);
    const at = new Date().toISOString();
    return [...latest.values()].flatMap((r) => skuIndexEntries(tenantId, r, 'indexed', at));
  });
}

async function ensureBarcodeIndex(store: EventStore, tenantId: string): Promise<void> {
  await ensureCatalogueIndex(store, tenantId, 'barcode-owner', async () => {
    const latest = new Map<string, BarcodeAssignment>();
    for (const a of await allOf<BarcodeAssignment>(store, tenantId, BARCODES_STREAM, 'BarcodeAssigned')) latest.set(a.code, a);
    const at = new Date().toISOString();
    return [...latest.values()].map((a) => ({ stream: barcodeOwnerStream(a.code), event: makeEvent({ id: `barcode-owner-${a.code}-indexed`, type: 'BarcodeOwnerIndexed', occurredAt: at, idempotencyKey: `barcode-owner-${tenantId}-${a.code}-indexed`, source: 'api/catalogue', payload: a }) }));
  });
}

/** Who holds a SKU now (other than `productId`), by key — and the version its write guard is at, read FIRST. */
async function skuHolderOf(store: EventStore, tenantId: string, sku: string, productId: string): Promise<{ holder?: string; version: number }> {
  await ensureSkuIndex(store, tenantId);
  const version = await store.guardVersion(tenantId, `sku:${sku}`);
  const claim = await store.latestOfType(tenantId, skuHolderStream(sku), 'SkuClaimed');
  const claimant = claim === undefined ? undefined : payloadOf<SkuIndexed>(claim).productId;
  if (claimant === undefined || claimant === productId) return { version };
  const now = await store.latestOfType(tenantId, productSkuStream(claimant), 'ProductSkuIndexed');
  return now !== undefined && payloadOf<SkuIndexed>(now).sku === sku ? { holder: claimant, version } : { version };
}


/** Why a product is in use (SF-06-b rollback guard): a barcode assigned to it, or a price set for it — or undefined. */
export async function productInUse(store: EventStore, tenantId: string, productId: string): Promise<string | undefined> {
  if ((await allOf<{ productId: string }>(store, tenantId, streamName(STREAM.catalogue, 'barcodes'), 'BarcodeAssigned')).some((b) => b.productId === productId)) return 'has a barcode';
  if ((await allOf<unknown>(store, tenantId, forPriceList(productId), 'PriceListEntryPublished')).length > 0) return 'has a price';
  return undefined;
}

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
    publish: async (tenantId, record, key, skuVersion) => {
      const at = input.now();
      // The product's version and its SKU index entries, in ONE atomic batch — guarded on the SKU when the caller read it.
      await ensureSkuIndex(input.store, tenantId);
      await input.store.appendBatch(tenantId, [{ stream, event: makeEvent({
        id: `product-${record.productId}-${key}`,
        type: 'ProductPublished',
        occurredAt: at,
        // Keyed on the caller's idempotency key so a retry dedups to one version; a deliberate re-publish
        // (a new key) is a new version.
        idempotencyKey: `product-${tenantId}-${record.productId}-${key}`,
        source: 'api/catalogue',
        payload: record,
      }) }, ...skuIndexEntries(tenantId, record, key, at)], skuVersion === undefined ? undefined : { guard: { key: `sku:${record.sku}`, expectedVersion: skuVersion } });
    },
    skuHolder: (tenantId, sku, productId) => skuHolderOf(input.store, tenantId, sku, productId),
    categoryRegister: { ...categoryRegisterAdapter(input), approvals: approvalRequestsAdapter(input) },
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
  const stream = BARCODES_STREAM;
  return {
    assign: async (tenantId, assignment, key, version) => {
      const at = input.now();
      await ensureBarcodeIndex(input.store, tenantId);
      // The assignment and its owner index entry in ONE atomic batch — guarded on the code when the caller read it.
      await input.store.appendBatch(tenantId, [{ stream, event: makeEvent({
        id: `barcode-${assignment.code}-${key}`,
        type: 'BarcodeAssigned',
        occurredAt: at,
        // Keyed on the caller's idempotency key so a retry dedups; a deliberate re-assign (new key) appends
        // a new version the fold's last-wins picks up.
        idempotencyKey: `barcode-${tenantId}-${assignment.code}-${key}`,
        source: 'api/catalogue',
        payload: assignment,
      }) }, { stream: barcodeOwnerStream(assignment.code), event: makeEvent({
        id: `barcode-owner-${assignment.code}-${key}`, type: 'BarcodeOwnerIndexed', occurredAt: at,
        idempotencyKey: `barcode-owner-${tenantId}-${assignment.code}-${key}`, source: 'api/catalogue', payload: assignment,
      }) }], version === undefined ? undefined : { guard: { key: `barcode:${assignment.code}`, expectedVersion: version } });
    },
    current: async (tenantId, code) => {
      await ensureBarcodeIndex(input.store, tenantId);
      const version = await input.store.guardVersion(tenantId, `barcode:${code}`); // read BEFORE the owner
      const owner = await input.store.latestOfType(tenantId, barcodeOwnerStream(code), 'BarcodeOwnerIndexed');
      return { version, ...(owner === undefined ? {} : { assignment: payloadOf<BarcodeAssignment>(owner) }) };
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
}): PackHierarchyDeps & { readonly packs: (tenantId: string) => Promise<ReadonlyMap<string, PackHierarchy>> } {
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
    // GT-05 (store volume): every product's current pack levels in one read.
    packs: foldLatest,
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
 * The per-tenant serviceability policy store (M18-FR-01 / D08) — the effective-dated radius/fee/threshold/
 * minimum that says which addresses the store delivers to and on what terms. A policy is a
 * `ServiceabilityPolicySet` event on one per-tenant stream; the schedule is every period ever set
 * (append-only, a change is a new later-dated period — hard rule #2). The route enforces the
 * one-policy-per-date rule before appending, and the tested `resolveServiceabilityPolicy` picks the period
 * in force (or the D08 default until the owner configures real radii).
 */
export function serviceabilityAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ServiceabilityConfigDeps {
  const stream = streamName(STREAM.delivery, 'serviceability');
  return {
    setPeriod: async (tenantId, period, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `svc-${period.effectiveFrom}-${key}`,
        type: 'ServiceabilityPolicySet',
        occurredAt: input.now(),
        idempotencyKey: `svc-${tenantId}-${period.effectiveFrom}-${key}`,
        source: 'api/orders',
        payload: period,
      }));
    },
    schedule: (tenantId) => allOf<ServiceabilityPeriod>(input.store, tenantId, stream, 'ServiceabilityPolicySet'),
  };
}

/**
 * The per-tenant company-wide consolidation store (M01 / M29 / D13, owner decision). Two append-only
 * streams: branch CONTRIBUTIONS (a branch's numbers for one family/period) and org MEMBERSHIPS (a branch's
 * effective-dated parent). The resolved contribution set is folded through the engine's own
 * `ingestContribution`, so the durable read applies the identical idempotency / correction-supersedes /
 * refuse-stale rules a fresh ingest would — a re-send never doubles a total and a later revision wins,
 * even after a cold restart (hard rules #2 #10). The tested `consolidate` rolls it up.
 */
export function consolidationAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ConsolidationDeps {
  const contribStream = streamName(STREAM.reporting, 'consolidation-contributions');
  const memberStream = streamName(STREAM.reporting, 'consolidation-memberships');
  return {
    recordContribution: async (tenantId, contribution, key) => {
      await input.store.append(tenantId, contribStream, makeEvent({
        id: `cc-${contribution.branchId}-${contribution.period}-${contribution.family}-${contribution.revision}`,
        type: 'ConsolidationContributionIngested',
        occurredAt: input.now(),
        idempotencyKey: `cc-${tenantId}-${key}`,
        source: 'api/reporting',
        payload: contribution,
      }));
    },
    // Fold EVERY contribution event through the engine's ingest rule, so a replayed/late/corrected event
    // resolves to exactly one contribution per (branch, period, family) — the same resolution the route uses.
    contributions: async (tenantId) => {
      const events = await allOf<BranchContribution>(input.store, tenantId, contribStream, 'ConsolidationContributionIngested');
      return events.reduce<readonly BranchContribution[]>((acc, c) => ingestContribution(acc, c).store, []);
    },
    recordMembership: async (tenantId, membership, key) => {
      await input.store.append(tenantId, memberStream, makeEvent({
        id: `cm-${membership.branchId}-${membership.from}`,
        type: 'ConsolidationMembershipSet',
        occurredAt: input.now(),
        idempotencyKey: `cm-${tenantId}-${key}`,
        source: 'api/reporting',
        payload: membership,
      }));
    },
    memberships: (tenantId) => allOf<BranchMembership>(input.store, tenantId, memberStream, 'ConsolidationMembershipSet'),
    now: input.now,
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
  readonly pricing?: CataloguePreviewDeps['pricing'];
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
    // SF-01: the offers the pack carries to the lanes (assembly keeps only the switched-on, not-yet-ended ones).
    promotions: promotionCatalogueAdapter(input).promotions,
    // SF-08: recalled and held batches' products go in the pack blocked, so every till refuses them offline.
    blockedProducts: saleBlocksAdapter(input).blockedProducts,
    cessSchedule: cessRateStore(input).schedule, // Till bill and GST (A7): the cess in force rides the pack
    ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
    now: input.now,
  };
}

/**
 * The store a lane's pack was published for — the pack at the sale's own `packVersion` (one index hit on
 * the version-scoped publish key), else the current one. `undefined` when no pack carries a scope (packs
 * published before the scope was recorded); the sale — and any return against it — then falls back to the
 * lane (`services/pos/src/sale-stock.ts`).
 */
export async function storeOfPack(store: EventStore, tenantId: string, packVersion: number): Promise<string | undefined> {
  const byVersion = await store.findByIdempotencyKey(tenantId, `catalogue-${tenantId}-v${packVersion}`);
  const pack = byVersion === undefined
    ? await latest<SignedPack>(store, tenantId, STREAM.catalogue, 'CataloguePublished')
    : (byVersion.event.payload as SignedPack);
  return pack?.snapshot.scope?.storeId;
}

/**
 * Round 14 (verifier G2): the store head office REGISTERED a lane (till) at — a registered `pos_lane` device in the device
 * registry that is not retired. undefined when the lane is not registered (its id is free text the till sends, never read
 * as a store).
 */
export async function storeOfLane(store: EventStore, tenantId: string, laneId: unknown): Promise<string | undefined> {
  if (typeof laneId !== 'string' || laneId.trim() === '') return undefined;
  const fleet = projectFleet(tenantId, await allOf<DeviceRegistryEvent>(store, tenantId, streamName(STREAM.platform, 'devices'), 'DeviceRegistryEvent'));
  // Round 16: a till is (store, till) — when more than one store registered a till of this name, the name alone places it
  // at no store (fail closed; the record's own store, or the caller's, decides).
  const lanes = fleet.filter((d) => d.deviceId === laneId && d.kind === 'pos_lane' && d.status !== 'retired');
  const lane = lanes.length === 1 ? lanes[0] : undefined;
  return lane === undefined || lane.branchId.trim() === '' ? undefined : lane.branchId;
}

/**
 * Where a sale's stock leaves from — the ONE deterministic rule (`resolveSaleStockLocation`: declared → the lane's
 * registered store → the pack's store → the lane's unplaced location) shared by banking, the FEFO read, returns,
 * exchanges and head office's judgement of a relayed sale or return (`services/api/src/relay-record-store.ts`).
 */
export async function saleStockLocationOf(store: EventStore, tenantId: string, sale: IncomingSale): Promise<SaleStockLocation> {
  if (typeof sale.locationId === 'string' && sale.locationId.trim() !== '') return resolveSaleStockLocation(sale, undefined);
  return resolveSaleStockLocation(sale, await storeOfPack(store, tenantId, sale.packVersion), await storeOfLane(store, tenantId, sale.laneId));
}

/** The batch a banked SALE appends (M08-FR-01, FND-01): the sale, its receipt-number index and one `sold`
 *  movement per line — shared by `posAdapter.bankSale` and the exchange's atomic commit, so both bank a sale
 *  identically. Each entry carries its own idempotency key; a resent sale dedups the whole set. */
function saleBatchEvents(tenantId: string, sale: IncomingSale, movements: readonly Movement[], bankedAt?: string): Parameters<EventStore['appendBatch']>[1] {
  // Round 29 · OB-108: the store computer's own time for the bill (when it took it from the till), kept on the receipt-number
  // index for the "said unused" check — only a well-formed one, and never later than head office received the bill (a store
  // computer cannot have taken a bill after head office had it: a time ahead is cut back to head office's).
  const boxAt = storeComputerTimeOf(sale.storeComputerTakenAt);
  const takenAt = boxAt === undefined ? undefined : bankedAt !== undefined && Date.parse(boxAt) > Date.parse(bankedAt) ? bankedAt : boxAt;
  return [
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
        payload: { receiptNumber: sale.receiptNumber, saleId: sale.saleId, ...(takenAt === undefined ? {} : { storeComputerTakenAt: takenAt }) },
      }),
    },
    // One outbound `sold` movement per line, in the SAME format the inventory adapter uses
    // (`mv-<movementId>`), so availability folds them exactly as any other movement and a resent
    // sale dedups each on its own key.
    ...movements.map((m) => ({
      stream: STREAM.inventory,
      event: makeEvent({
        id: `mv-${m.movementId}`,
        type: 'InventoryMoved',
        occurredAt: m.occurredAt,
        idempotencyKey: `mv-${tenantId}-${m.movementId}`,
        source: 'api/pos',
        payload: m,
      }),
    })),
  ];
}

/** The batch a recorded RETURN appends (M13, FND-01): the bill's register entry, the tenant-wide reporting
 *  projection, any store credit (instrument + movement) and one `returned` movement per resold line — shared by
 *  `returnsAdapter.recordReturn` and the exchange's atomic commit. */
/** PF-14 — returned goods held off the shelf, one register for the tenant (`GET /v1/returns/held-stock`). */
const HELD_RETURNED_STOCK = streamName(STREAM.returns, 'held-stock');

/** PF-14 — one `ReturnedStockHeld` per non-resell line of a return, in the return's own batch (they land together). */
function heldStockEvents(tenantId: string, held: readonly HeldReturnedStock[]): Parameters<EventStore['appendBatch']>[1] {
  return held.map((h) => ({
    stream: HELD_RETURNED_STOCK,
    event: makeEvent({
      id: h.heldId, type: 'ReturnedStockHeld', occurredAt: h.heldAt,
      idempotencyKey: `${tenantId}-${h.heldId}`, source: 'api/pos', payload: h,
    }),
  }));
}

function returnBatchEvents(
  tenantId: string, saleId: string, record: ReturnRecord, storeCredit: StoreCreditIssue | undefined, stockMovements: readonly Movement[],
  location?: SaleStockLocation,
): Parameters<EventStore['appendBatch']>[1] {
  return [
    // PF-14: what came back but cannot be sold — held where it came back, with its lot, linked to this return.
    ...heldStockEvents(tenantId, heldReturnedStock(record, location)),
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
    // A fresh store-credit instrument (when one was opened) on the shared index, so it can be found
    // and pooled by owner.
    ...(storeCredit?.instrument === undefined ? [] : [{
      stream: STORED_VALUE_INDEX,
      event: makeEvent({
        id: `sv-issue-${storeCredit.instrument.instrumentId}`,
        type: 'StoredValueIssued',
        occurredAt: storeCredit.instrument.issuedAt,
        idempotencyKey: `sv-issue-${tenantId}-${storeCredit.instrument.instrumentId}`,
        source: 'api/pos',
        payload: storeCredit.instrument,
      }),
    }]),
    // The refund_to_credit movement on the instrument's own stream, where the balance folds.
    ...(storeCredit === undefined ? [] : [{
      stream: forInstrument(storeCredit.movement.instrumentId),
      event: makeEvent({
        id: `sv-mv-${storeCredit.movement.movementId}`,
        type: 'StoredValueMovement',
        occurredAt: storeCredit.movement.at,
        idempotencyKey: `sv-mv-${tenantId}-${storeCredit.movement.movementId}`,
        source: 'api/pos',
        payload: storeCredit.movement,
      }),
    }]),
    // One inbound `returned` movement per resold line, in the inventory adapter's own format
    // (`mv-<movementId>`), so availability and valuation fold it as any other movement.
    ...stockMovements.map((m) => ({
      stream: STREAM.inventory,
      event: makeEvent({
        id: `mv-${m.movementId}`,
        type: 'InventoryMoved',
        occurredAt: m.occurredAt,
        idempotencyKey: `mv-${tenantId}-${m.movementId}`,
        source: 'api/pos',
        payload: m,
      }),
    })),
  ];
}

export function posAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PosDeps {
  return {
    now: input.now,
    // Round 35 · NEW-6: only the store computer's own sign-in may say when it took a bill.
    storeComputerScopeOf: (tenantId, userId) => storeComputerScopeHeldBy(input.store, tenantId, userId),

    // SP-4b · F09: the cashier a till names is re-verified from their grants — the same register every relayed identity
    // is checked against — so a sale under an unknown or unauthorised name is a finding the manager sees.
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),

    catalogue: async (tenantId) => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return new Map((pack?.snapshot.products ?? []).map((p: CatalogueProduct) => [p.productId, p]));
    },

    currentPackVersion: async (tenantId) =>
      (await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished'))?.snapshot.version ?? 0,

    // OB-35 "A": the batches on hand where this sale's stock leaves from (the same location `bankSale` resolves), earliest
    // expiry first — Batch 2's FEFO read over the one batch projection, called once per sale.
    lotsOnHand: async (tenantId, sale) => {
      const { locationId } = await saleStockLocationOf(input.store, tenantId, sale);
      const batches = await inventoryAdapter({ store: input.store, now: input.now }).batches!(tenantId);
      return (productId) => fefoBatchesAt(batches, locationId, productId);
    },

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
    // Hard rule #10 · OB-87: the bill banked under this id (one indexed hit), so a different bill re-sent under it is a finding.
    bankedSale: async (tenantId, saleId) =>
      (await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`))?.event.payload as IncomingSale | undefined,

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
      // A sale IS a stock movement (M08-FR-01: "a movement (receive/sell/…) appends an event"). Its `sold`
      // movements are resolved here — to the location the lane declared, else the store its pack was
      // published for, else the lane itself (stated on the movement, never silent) — and appended in the
      // SAME batch as the sale, so on-hand, valuation, COGS and near-expiry all fold the sale from the one
      // ledger. Before this, a banked sale never reduced on-hand (hosted-demo finding H-13).
      const movements = saleStockMovements(sale, await saleStockLocationOf(input.store, tenantId, sale));
      // The sale and its receipt-number index are ONE atomic batch (audit FND-01): a crash between
      // them must never leave a banked sale with no receipt index, nor an index pointing at a sale
      // that did not commit. Both carry their own idempotency key, so a till resending the sale
      // dedups the whole batch.
      await input.store.appendBatch(tenantId, saleBatchEvents(tenantId, sale, movements, input.now()));
    },

    recordExceptions: async (tenantId, exceptions) => {
      for (const ex of exceptions) {
        await input.store.append(tenantId, STREAM.saleExceptions, makeEvent({
          // The kind, not the position, names it: a later finding on the same sale (a loyalty spend that could not be
          // covered, PF-09 step 3) must not collide with the intake's own first finding.
          id: `saleex-${ex.saleId}-${ex.kind}`,
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

/**
 * The quality hold/release register (M10-FR-02) — the durable cloud record of every quality hold. Each
 * placement is a `QualityHeld` event and each release a `QualityReleased` event on the tenant's
 * quality-hold stream, each carrying the resulting `QualityHold`; nothing is ever overwritten (hard
 * rule #2/#6). The current state per batch is the latest event's record; the write surface runs the
 * tested `releaseFromQualityHold` engine over that current hold.
 */
const QUALITY_HOLD_STREAM = streamName(STREAM.inventory, 'quality-holds');

/** One `QualityHeld` fact — the same event whether a person placed the hold or a room's breach did (PA-07). */
function qualityHeldEntry(tenantId: string, hold: QualityHold, key: string, now: string): { stream: string; event: DomainEvent } {
  return {
    stream: QUALITY_HOLD_STREAM,
    event: makeEvent({
      id: `qhold-${hold.batchId}-held-${key}`,
      type: 'QualityHeld',
      occurredAt: now,
      idempotencyKey: `qhold-${tenantId}-${hold.batchId}-held-${key}`,
      source: 'api/inventory',
      payload: hold,
    }),
  };
}

/** The idempotency key of a hold an equipment excursion placed — one per batch per excursion. */
const equipmentHoldKey = (hold: QualityHold): string => `equip-${hold.equipment?.assetId ?? ''}-${hold.equipment?.episodeId ?? ''}`;

export function qualityHoldAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): QualityHoldDeps {
  const stream = QUALITY_HOLD_STREAM;
  const events = (tenantId: string) => input.store.readStream(tenantId, stream); // both types, oldest first
  const latestByBatch = async (tenantId: string): Promise<Map<string, QualityHold>> => {
    const byBatch = new Map<string, QualityHold>();
    for (const e of await events(tenantId)) {
      const h = payloadOf<QualityHold>(e);
      byBatch.set(h.batchId, h); // each event's payload IS the resulting record; latest wins
    }
    return byBatch;
  };
  return {
    now: input.now,
    hold: async (tenantId, batchId) => (await latestByBatch(tenantId)).get(batchId),
    holds: async (tenantId) => [...(await latestByBatch(tenantId)).values()],
    recordHeld: async (tenantId, hold, key) => {
      const entry = qualityHeldEntry(tenantId, hold, key, input.now());
      await input.store.append(tenantId, entry.stream, entry.event);
    },
    recordReleased: async (tenantId, hold, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `qhold-${hold.batchId}-released-${key}`,
        type: 'QualityReleased',
        occurredAt: input.now(),
        idempotencyKey: `qhold-${tenantId}-${hold.batchId}-released-${key}`,
        source: 'api/inventory',
        payload: hold,
      }));
    },
  };
}

/**
 * SF-08: head office's list of what must not be sold — every batch under an OPEN recall and every batch on quality
 * HOLD, each named to its product. A hold names its product; a recall names only its batch, so its product is found on
 * the stock ledger (every batch head office ever received or moved). A batch it cannot name stays `productId: null` —
 * shown, never guessed. Folded from the two append-only registers on every read; nothing is stored twice.
 */
export function saleBlocksAdapter(input: { readonly store: EventStore; readonly now: () => string }): SaleBlockDeps & {
  readonly blockedProducts: (tenantId: string) => Promise<ReadonlySet<string>>;
} {
  const recalls = recallAdapter(input);
  const holds = qualityHoldAdapter(input);
  const inv = inventoryAdapter(input);
  const blocks = async (tenantId: string): Promise<readonly SaleBlock[]> => {
    const out: SaleBlock[] = [];
    for (const h of await holds.holds(tenantId)) {
      if (h.status === 'released') continue;
      out.push({ productId: h.productId, batchId: h.batchId, kind: 'quality_hold', since: h.heldAt, reason: h.reason });
    }
    const open = (await recalls.records(tenantId)).filter((r) => r.status === 'open');
    if (open.length > 0) {
      const productsOf = new Map<string, Set<string>>();
      for (const b of await inv.batches!(tenantId)) {
        if (b.batchId === null) continue;
        const set = productsOf.get(b.batchId) ?? new Set<string>();
        set.add(b.productId);
        productsOf.set(b.batchId, set);
      }
      for (const r of open) {
        const products = [...(productsOf.get(r.batchId) ?? [])].sort();
        // A batch id two products share blocks both — the safe reading of a recall that names only the batch.
        if (products.length === 0) out.push({ productId: null, batchId: r.batchId, kind: 'recall', since: r.initiatedAt, reason: r.reason });
        for (const productId of products) out.push({ productId, batchId: r.batchId, kind: 'recall', since: r.initiatedAt, reason: r.reason });
      }
    }
    return out;
  };
  return {
    blocks,
    blockedProducts: async (tenantId) => blockedProductIds(await blocks(tenantId)),
    currentPack: (tenantId) => latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished'),
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
 * Near-expiry stock (M10-FR-01 · A03 · ADR-0015). Folds the store's own ledger into the batches on hand now
 * that are expired (dispose) or near expiry (markdown): received batches carry their expiry (ADR-0015), what
 * has sold is estimated FIFO-by-receipt (ADR-0006) and netted off, and wastage is subtracted. A pure READ,
 * reusing the same tested `nearExpiryStock`/`attributeSalesFifo`/`expiryActions` engines — no second copy of
 * the rules. The universe of batch-tracked products is exactly those with a received batch, so no catalogue
 * lookup is needed and a sale of a non-batch product is ignored.
 */
export function nearExpiryAdapter(input: { readonly store: EventStore; readonly now: () => string }): NearExpiryDeps {
  return {
    now: input.now,
    nearExpiry: async (tenantId, opts) => {
      const moves = (await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => payloadOf<Movement>(e))
        // PA-01-r1: a branch-limited read folds only its own locations' receipts, sales and waste.
        .filter((m) => opts.covers === undefined || opts.covers(m.locationId));
      const receipts: ReceiptWithExpiry[] = moves
        .filter((m) => m.kind === 'received' && typeof m.batchId === 'string' && m.batchId !== '')
        .map((m) => ({
          batchId: m.batchId as string,
          productId: m.productId,
          receivedDate: m.occurredAt.slice(0, 10),
          qty: m.quantityMinor,
          ...(typeof m.expiry === 'string' && m.expiry !== '' ? { expiry: m.expiry } : {}),
        }));
      if (receipts.length === 0) return [];
      const wastage = moves
        .filter((m) => m.kind === 'wasted' && typeof m.batchId === 'string' && m.batchId !== '')
        .map((m) => ({ batchId: m.batchId as string, qty: m.quantityMinor }));
      // Sales only matter for products we actually received a batch of (those are the batch-tracked ones).
      const receivedProducts = new Set(receipts.map((r) => r.productId));
      // What has SOLD comes from the same ledger: every banked sale appends its `sold` movements (M08-FR-01,
      // `services/pos/src/sale-stock.ts`), so netting reads them here rather than the sales stream — one
      // source of truth for on-hand, and no double count against availability. A captured batch rides on
      // the movement; an uncaptured one is estimated FIFO-by-receipt exactly as before (ADR-0006).
      const saleLines: SaleForNetOnHand[] = moves
        .filter((m) => m.kind === 'sold' && receivedProducts.has(m.productId))
        .map((m) => ({
          saleId: m.movementId,
          soldDate: m.occurredAt.slice(0, 10),
          qty: m.quantityMinor,
          batchTracked: true,
          productId: m.productId,
          ...(typeof m.batchId === 'string' && m.batchId !== '' ? { capturedBatchId: m.batchId } : {}),
        }));
      return nearExpiryStock({ receipts, sales: saleLines, wastage, asOf: opts.asOf, nearExpiryDays: opts.nearExpiryDays });
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

/** The write-guard key for everything that refunds against one sale (Wave 2a · PF-01). */
export const refundGuardKey = (saleId: string): string => `refund:${saleId}`;
/** The write-guard key for everything that leaves one location's stock by transfer (Wave 2a · SF-04). */
export const stockGuardKey = (locationId: string): string => `stock:${locationId}`;
/** Batch 2: one plain transfer's own write guard — two resolutions of its shortfall cannot both land. */
export const transferGuardKey = (transferId: string): string => `transfer:${transferId}`;
/** Batch 2: one floor indent's own write guard — two counts (or two resolutions) of one issue cannot both land. */
export const indentGuardKey = (indentId: string): string => `indent:${indentId}`;
/** SF-02 — a purchase order's write guard: every receipt, cancellation, amendment and posting against it moves it. */
export const purchaseOrderGuardKey = (poId: string): string => `purchase-order:${poId}`;

/**
 * SF-02 — append a change to a purchase order (a cancellation, an amendment, a hand-posted receipt, an accepted excess)
 * MOVING the order's guard, so a goods receipt judged on the order as it stood before this change is refused rather than
 * doubled. The change itself depends on no figure read here, so a lost race is simply tried again (with a short jitter).
 */
async function appendMovingOrder(store: EventStore, tenantId: string, poId: string, entries: readonly BatchEntry[],
  /** OB-63: a guard the move must ALSO hold (the month's open-to-buy) — its loss is never retried here: the caller judged on it. */
  alsoGuard?: WriteGuard,
  /** Round 13: the order version the caller JUDGED on — then the move holds exactly that version and is never re-tried. */
  pinnedVersion?: number): Promise<void> {
  const key = purchaseOrderGuardKey(poId);
  for (let attempt = 0; ; attempt++) {
    const expectedVersion = pinnedVersion ?? await store.guardVersion(tenantId, key);
    try {
      await store.appendBatch(tenantId, entries, { guard: { key, expectedVersion }, ...(alsoGuard === undefined ? {} : { alsoGuards: [alsoGuard] }) });
      return;
    } catch (err) {
      if (!(err instanceof ConcurrencyConflictError) || attempt >= 8 || err.key !== key || pinnedVersion !== undefined) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8 * (attempt + 1))));
    }
  }
}
/** The write-guard key for every promise held at one location (Wave 2a · FUL-02). */
export const reservationGuardKey = (locationId: string): string => `reservation:${locationId}`;

/** The write-guard key of one head-office refund approval (ADR-0022): a return with no bill spends it under this. */
export const refundApprovalGuardKey = (approvalId: string): string => `refund-approval:${approvalId}`;
const REFUND_APPROVALS = 'pos-refund-approvals';

/** An approval head office gave and, once spent, the refund that spent it — found by its own keys, never a scan. */
async function readRefundApproval(store: EventStore, tenantId: string, approvalId: string): Promise<RefundApprovalState | undefined> {
  const given = await store.findByIdempotencyKey(tenantId, `refund-approval-${tenantId}-${approvalId}`);
  if (given === undefined) return undefined;
  const used = await store.findByIdempotencyKey(tenantId, `refund-approval-used-${tenantId}-${approvalId}`);
  const usedBy = (used?.event.payload as { usedBy?: unknown } | undefined)?.usedBy;
  return { approval: given.event.payload as RefundApproval, ...(typeof usedBy === 'string' ? { usedBy } : {}) };
}

/** The spending of approvals, as entries for the refund's OWN atomic batch (ADR-0022): one approval, one refund. */
function approvalUseEntries(tenantId: string, uses: readonly ApprovalUse[] | undefined, at: string): BatchEntry[] {
  return (uses ?? []).map((u) => ({
    stream: REFUND_APPROVALS,
    event: makeEvent({
      // The id names the USE (approval + the refund spending it); the idempotency key names the APPROVAL. Two refunds
      // spending one approval at the same moment then collide only on the key — which the store resolves by waiting
      // for the winner and deduping — and the loser's guard refuses it by name (409), never a raw duplicate-id error.
      id: `refund-approval-used-${u.approvalId}-by-${u.usedBy}`,
      type: 'RefundApprovalUsed',
      occurredAt: at,
      idempotencyKey: `refund-approval-used-${tenantId}-${u.approvalId}`,
      source: 'api/pos',
      payload: { approvalId: u.approvalId, usedBy: u.usedBy },
    }),
  }));
}

/** Head office's refund approvals (ADR-0022): given by the approver in their own session; read by id. */
export function refundApprovalsAdapter(input: { readonly store: EventStore; readonly now: () => string }): RefundApprovalDeps & {
  readonly refundApproval: (tenantId: string, approvalId: string) => Promise<RefundApprovalState | undefined>;
  readonly approvalVersion: (tenantId: string, approvalId: string) => Promise<number>;
} {
  return {
    now: input.now,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    recordRefundApproval: async (tenantId, approval) => {
      await input.store.append(tenantId, REFUND_APPROVALS, makeEvent({
        id: `refund-approval-${approval.approvalId}`,
        type: 'RefundApprovalGiven',
        occurredAt: approval.givenAt,
        idempotencyKey: `refund-approval-${tenantId}-${approval.approvalId}`,
        source: 'api/pos',
        payload: approval,
      }));
    },
    refundApproval: (tenantId, approvalId) => readRefundApproval(input.store, tenantId, approvalId),
    approvalVersion: (tenantId, approvalId) => input.store.guardVersion(tenantId, refundApprovalGuardKey(approvalId)),
  };
}

// ── Head office's maker-checker engine (ADR-0024 · M02-FR-03 · audit PA-03) ─────────────────────────────────────────
/** One guard per request: a decision and the one use of an approval both bump it, so two checkers, or two actions, racing
 *  on one request cannot both land. */
export const approvalRequestGuardKey = (requestId: string): string => `approval-request:${requestId}`;
const APPROVAL_REQUESTS = 'approval-requests';

async function readApprovalState(store: EventStore, tenantId: string, requestId: string): Promise<ApprovalState | undefined> {
  const asked = await store.findByIdempotencyKey(tenantId, `approval-request-${tenantId}-${requestId}`);
  if (asked === undefined) return undefined;
  const decided = await store.findByIdempotencyKey(tenantId, `approval-decision-${tenantId}-${requestId}`);
  const used = await store.findByIdempotencyKey(tenantId, `approval-used-${tenantId}-${requestId}`);
  const usedBy = (used?.event.payload as { usedBy?: unknown } | undefined)?.usedBy;
  return {
    request: asked.event.payload as ApprovalRequest,
    ...(decided === undefined ? {} : { decision: decided.event.payload as ApprovalDecision }),
    ...(typeof usedBy === 'string' ? { usedBy } : {}),
  };
}

/** The maker-checker engine's store (ADR-0024): requests, decisions and uses — append-only, one guard per request. */
export function approvalRequestsAdapter(input: { readonly store: EventStore; readonly now: () => string }): ApprovalRequestDeps & {
  /** Spend an approved request for one action, under the request's guard read before it was judged. Resolves `false`
   *  when another use landed first; throws `ConcurrencyConflictError` when the guard moved under it. */
  readonly spendApproval: (tenantId: string, requestId: string, usedBy: string, expectedVersion: number) => Promise<boolean>;
} {
  return {
    now: input.now,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    recordRequest: async (tenantId, request) => {
      await input.store.append(tenantId, APPROVAL_REQUESTS, makeEvent({
        id: `approval-request-${request.requestId}`, type: 'ApprovalRequested', occurredAt: request.requestedAt,
        idempotencyKey: `approval-request-${tenantId}-${request.requestId}`, source: 'api/approvals', payload: request,
      }));
    },
    recordDecision: async (tenantId, decision, expectedVersion) => {
      const [result] = await input.store.appendBatch(tenantId, [{
        stream: APPROVAL_REQUESTS,
        event: makeEvent({
          // The KEY names the request, so only one decision can ever land; the id is this attempt's own, so two checkers
          // at the same moment meet on the key (one lands, the other reads it back) — never a duplicate-id crash.
          id: `approval-decision-${decision.requestId}-${randomUUID()}`, type: 'ApprovalDecided', occurredAt: decision.decidedAt,
          idempotencyKey: `approval-decision-${tenantId}-${decision.requestId}`, source: 'api/approvals', payload: decision,
        }),
      }], { guard: { key: approvalRequestGuardKey(decision.requestId), expectedVersion } });
      // The decision that stands — the other checker's, when theirs landed first.
      return result!.record.event.payload as ApprovalDecision;
    },
    approvalState: (tenantId, requestId) => readApprovalState(input.store, tenantId, requestId),
    approvalVersion: (tenantId, requestId) => input.store.guardVersion(tenantId, approvalRequestGuardKey(requestId)),
    allRequests: async (tenantId) => {
      const events = await input.store.readStream(tenantId, APPROVAL_REQUESTS);
      const byId = new Map<string, { request?: ApprovalRequest; decision?: ApprovalDecision; usedBy?: string }>();
      for (const e of events) {
        const p = e.event.payload as { requestId?: string; usedBy?: string };
        if (typeof p.requestId !== 'string') continue;
        const cur = byId.get(p.requestId) ?? {};
        if (e.event.type === 'ApprovalRequested') cur.request = e.event.payload as ApprovalRequest;
        else if (e.event.type === 'ApprovalDecided') cur.decision ??= e.event.payload as ApprovalDecision;
        else if (e.event.type === 'ApprovalUsed' && typeof p.usedBy === 'string') cur.usedBy ??= p.usedBy;
        byId.set(p.requestId, cur);
      }
      return [...byId.values()].flatMap((v): ApprovalState[] => (v.request === undefined ? [] : [{
        request: v.request, ...(v.decision === undefined ? {} : { decision: v.decision }), ...(v.usedBy === undefined ? {} : { usedBy: v.usedBy }),
      }]));
    },
    spendApproval: async (tenantId, requestId, usedBy, expectedVersion) => {
      // As a decision: the key names the request (one use, ever), the id is this attempt's own. A use that met another
      // already there did NOT land — even when it is the same action sent twice — so only one of them proceeds.
      const [result] = await input.store.appendBatch(tenantId, [{
        stream: APPROVAL_REQUESTS,
        event: makeEvent({
          id: `approval-used-${requestId}-${randomUUID()}`, type: 'ApprovalUsed', occurredAt: input.now(),
          idempotencyKey: `approval-used-${tenantId}-${requestId}`, source: 'api/approvals', payload: { requestId, usedBy },
        }),
      }], { guard: { key: approvalRequestGuardKey(requestId), expectedVersion } });
      return !result!.deduped;
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
    // Round 35 · NEW-6: only the store computer's own sign-in may say when it took a refund.
    storeComputerScopeOf: (tenantId, userId) => storeComputerScopeHeldBy(input.store, tenantId, userId),

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
        // PF-14: each line's batch and use-by date as the lane sold it — a return takes its lot from here.
        lines: s.lines.map((l) => ({
          productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor, lineTotalMinor: l.lineTotalMinor,
          ...(typeof l.batchId === 'string' && l.batchId !== '' ? { batchId: l.batchId } : {}),
          ...(typeof l.batchExpiry === 'string' && l.batchExpiry !== '' ? { batchExpiry: l.batchExpiry } : {}),
        })),
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

    // The sale's refund guard (Wave 2a · PF-01): one version per sale, read before the history and bumped by every
    // return that lands against it, on whichever path — desk, online or synced from a lane.
    refundVersion: (tenantId, saleId) => input.store.guardVersion(tenantId, refundGuardKey(saleId)),

    refundApproval: (tenantId, approvalId) => readRefundApproval(input.store, tenantId, approvalId),

    recordReturn: async (tenantId, saleId, record, storeCredit, expectedVersion, approvalUses) => {
      // The register entry and its reporting projection are ONE atomic batch (audit FND-01). Before,
      // the projection was a second, additive append that a crash could drop — leaving the money and
      // the per-sale register correct but the tenant-wide returns-netting report short one return.
      // Batching them removes that window: both land together or neither does, and each keeps its own
      // idempotency key so a lane retrying an unconfirmed refund still dedups the whole batch (the
      // money leaves once however many times the till re-sends it).
      // A store-credit refund issues a spendable instrument IN THE SAME BATCH (M13-FR-03) — the return
      // and the credit land together or not at all, each with its own idempotency key so a lane retry
      // issues the credit once. Same event shapes the stored-value adapter writes, so the balance
      // projection, household pooling and liability reconciliation read it identically.
      //
      // A RESOLD return is a stock movement (M08-FR-01 names "return"): its `returned` movements re-enter
      // sellable on-hand at the location the original sale drew from — the same rule as the sale (declared
      // → the store of its pack → its lane) — in this SAME batch, so the shelf and the money agree.
      // Quarantined, damaged and scrapped lines never re-enter here (M08-FR-02 / M10 / M28). Without the
      // original sale on this ledger there is no location to name and no movement is guessed (P-08): the
      // return still records, and the desk's own finding says the sale was never seen.
      const original = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`);
      const originalSale = original === undefined ? undefined : (original.event.payload as IncomingSale);
      const location = originalSale === undefined ? undefined : await saleStockLocationOf(input.store, tenantId, originalSale);
      const stockMovements = location === undefined ? [] : returnStockMovements(record, location);
      // A desk refund's approval (ADR-0022) is spent in this SAME batch, under the sale's guard: one approval, one refund.
      await input.store.appendBatch(
        tenantId,
        [...returnBatchEvents(tenantId, saleId, record, storeCredit, stockMovements, location), ...approvalUseEntries(tenantId, approvalUses, record.processedAt)],
        expectedVersion === undefined ? undefined : { guard: { key: refundGuardKey(saleId), expectedVersion } },
      );
    },

    // The tenant's refund approval threshold (M13-FR-03) — tenant-wide config, append-only (latest wins).
    refundThreshold: async (tenantId) => {
      const all = await allOf<{ thresholdMinor: number }>(input.store, tenantId, streamName(STREAM.returns, 'refund-threshold'), 'RefundThresholdSet');
      const last = all[all.length - 1];
      return last === undefined ? undefined : last.thresholdMinor;
    },
    recordRefundThreshold: async (tenantId, thresholdMinor, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, streamName(STREAM.returns, 'refund-threshold'), makeEvent({
        id: `refund-threshold-${d}`,
        type: 'RefundThresholdSet',
        occurredAt: input.now(),
        idempotencyKey: `refund-threshold-${tenantId}-${d}`,
        source: 'api/pos',
        payload: { thresholdMinor },
      }));
    },

    // The tenant's return window (M13-FR-02) — tenant-wide config, append-only (latest wins). Undefined
    // until the owner sets one, so a return is not age-restricted until then (AVR-07).
    returnWindow: async (tenantId) => {
      const all = await allOf<{ returnWindowDays: number }>(input.store, tenantId, streamName(STREAM.returns, 'return-window'), 'ReturnWindowSet');
      const last = all[all.length - 1];
      return last === undefined ? undefined : last.returnWindowDays;
    },
    recordReturnWindow: async (tenantId, returnWindowDays, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, streamName(STREAM.returns, 'return-window'), makeEvent({
        id: `return-window-${d}`,
        type: 'ReturnWindowSet',
        occurredAt: input.now(),
        idempotencyKey: `return-window-${tenantId}-${d}`,
        source: 'api/pos',
        payload: { returnWindowDays },
      }));
    },

    // The tenant's store-credit issuance cap (M13-FR-03 / M17) — tenant-wide config, append-only (latest
    // wins). Undefined until the owner sets one, so store-credit refunds stay unavailable until then.
    storeCreditCap: async (tenantId) => {
      const all = await allOf<{ capMinor: number }>(input.store, tenantId, streamName(STREAM.returns, 'store-credit-cap'), 'StoreCreditCapSet');
      const last = all[all.length - 1];
      return last === undefined ? undefined : last.capMinor;
    },
    recordStoreCreditCap: async (tenantId, capMinor, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, streamName(STREAM.returns, 'store-credit-cap'), makeEvent({
        id: `store-credit-cap-${d}`,
        type: 'StoreCreditCapSet',
        occurredAt: input.now(),
        idempotencyKey: `store-credit-cap-${tenantId}-${d}`,
        source: 'api/pos',
        payload: { capMinor },
      }));
    },
    // The §28 authority to approve a refund (M13-FR-03) — pos.return.approve, held by a supervisor/manager
    // (owner + store_manager), above the cashier. A named approver who does not hold it does not count.
    canApproveRefund: async (tenantId, userId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
      return ROLE_CATALOGUE.some((r) => roleIds.has(r.id) && r.permissions.includes('pos.return.approve'));
    },

    // Synced refunds that reconciled with a §28 breach (M13-FR-01), folded from the tenant-wide returns
    // projection — flagged records only, one per return id (latest wins on a re-sync). The visible loss
    // surface a person works (hard rule #10).
    // PF-14: every returned unit held off the shelf, in the order it came back.
    heldReturnedStock: (tenantId) => allOf<HeldReturnedStock>(input.store, tenantId, HELD_RETURNED_STOCK, 'ReturnedStockHeld'),

    flaggedReturns: async (tenantId) => {
      const all = await allOf<ReturnRecord>(input.store, tenantId, STREAM.returns, 'ReturnRecorded');
      const byId = new Map<string, ReturnRecord>();
      for (const r of all) if (r.governanceFlags !== undefined && r.governanceFlags.length > 0) byId.set(r.returnId, r);
      return [...byId.values()];
    },
  };
}

/** The no-receipt register — its own stream, never a bill's (a no-receipt return counts against no sale). */
const NO_RECEIPT_RETURNS = streamName(STREAM.returns, 'no-receipt');

/**
 * Controlled no-receipt returns (M13-FR-01, CH-01 un-parked) — the cap the owner sets, the catalogue check,
 * the register + tenant-wide projection, and the report. Shares the §28 authority read and the store-credit
 * cap with `returnsAdapter` so there is ONE reading of each policy. `recordNoReceiptReturn` mirrors
 * `recordReturn`'s atomic batch: register entry + reporting projection + store credit + `returned` movements,
 * each on its own idempotency key, so a retried refund lands once and the money, the report and the shelf agree.
 */
export function noReceiptReturnsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<NoReceiptReturnsDeps, 'recordAudit'> {
  const shared = returnsAdapter(input);
  return {
    now: input.now,
    ...(shared.storeComputerScopeOf === undefined ? {} : { storeComputerScopeOf: shared.storeComputerScopeOf }),
    canApproveRefund: shared.canApproveRefund,
    storeCreditCap: shared.storeCreditCap,

    // The owner's no-receipt cap — tenant-wide config, append-only (latest wins). Undefined until set, so the
    // no-receipt path stays unavailable until the owner decides (fail-safe, never a guessed default).
    noReceiptCap: async (tenantId) => {
      const all = await allOf<{ capMinor: number }>(input.store, tenantId, streamName(STREAM.returns, 'no-receipt-cap'), 'NoReceiptCapSet');
      const last = all[all.length - 1];
      return last === undefined ? undefined : last.capMinor;
    },
    recordNoReceiptCap: async (tenantId, capMinor, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, streamName(STREAM.returns, 'no-receipt-cap'), makeEvent({
        id: `no-receipt-cap-${d}`,
        type: 'NoReceiptCapSet',
        occurredAt: input.now(),
        idempotencyKey: `no-receipt-cap-${tenantId}-${d}`,
        source: 'api/pos',
        payload: { capMinor },
      }));
    },

    // "Identify the item": the product must have been published to this tenant's catalogue (the same fold the
    // product master reads — the last publish of an id wins, and any publish means the shop sells it).
    knownProduct: async (tenantId, productId) => {
      const events = await input.store.readStream(tenantId, streamName(STREAM.catalogue, 'products'), { type: 'ProductPublished' });
      return events.some((e) => payloadOf<{ productId: string }>(e).productId === productId);
    },

    refundApproval: (tenantId, approvalId) => readRefundApproval(input.store, tenantId, approvalId),
    approvalVersion: (tenantId, approvalId) => input.store.guardVersion(tenantId, refundApprovalGuardKey(approvalId)),
    recordNoReceiptReturn: async (tenantId, record, storeCredit, location, approvalUse) => {
      const stockMovements = location === undefined ? [] : returnStockMovements(record, location);
      await input.store.appendBatch(tenantId, [
        // PF-14: what came back but cannot be sold — held, linked to this return (where it came back, when stated).
        ...heldStockEvents(tenantId, heldReturnedStock(record, location)),
        // The approval it spends (ADR-0022), in this same batch, under that approval's own guard.
        ...approvalUseEntries(tenantId, approvalUse === undefined ? undefined : [approvalUse.use], record.processedAt),
        {
          stream: NO_RECEIPT_RETURNS,
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
          // The tenant-wide returns projection (reporting + the governance-exceptions fold), keyed on the return id.
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
        ...(storeCredit?.instrument === undefined ? [] : [{
          stream: STORED_VALUE_INDEX,
          event: makeEvent({
            id: `sv-issue-${storeCredit.instrument.instrumentId}`,
            type: 'StoredValueIssued',
            occurredAt: storeCredit.instrument.issuedAt,
            idempotencyKey: `sv-issue-${tenantId}-${storeCredit.instrument.instrumentId}`,
            source: 'api/pos',
            payload: storeCredit.instrument,
          }),
        }]),
        ...(storeCredit === undefined ? [] : [{
          stream: forInstrument(storeCredit.movement.instrumentId),
          event: makeEvent({
            id: `sv-mv-${storeCredit.movement.movementId}`,
            type: 'StoredValueMovement',
            occurredAt: storeCredit.movement.at,
            idempotencyKey: `sv-mv-${tenantId}-${storeCredit.movement.movementId}`,
            source: 'api/pos',
            payload: storeCredit.movement,
          }),
        }]),
        // One inbound `returned` movement per resold line at the named location (M08-FR-01) — the same
        // format the inventory adapter writes, so availability and valuation fold it as any other movement.
        ...stockMovements.map((m) => ({
          stream: STREAM.inventory,
          event: makeEvent({
            id: `mv-${m.movementId}`,
            type: 'InventoryMoved',
            occurredAt: m.occurredAt,
            idempotencyKey: `mv-${tenantId}-${m.movementId}`,
            source: 'api/pos',
            payload: m,
          }),
        })),
      ], approvalUse === undefined ? undefined : { guard: { key: refundApprovalGuardKey(approvalUse.use.approvalId), expectedVersion: approvalUse.expectedVersion } });
    },

    // The no-receipt register, one record per return id (latest wins on a re-sync).
    noReceiptReturns: async (tenantId) => {
      const all = await allOf<ReturnRecord>(input.store, tenantId, NO_RECEIPT_RETURNS, 'ReturnRecorded');
      const byId = new Map<string, ReturnRecord>();
      for (const r of all) byId.set(r.returnId, r);
      return [...byId.values()];
    },
  };
}

/**
 * Exchanges (M13-FR-03, CH-01 half 2): the return half reads the bill's register through `returnsAdapter`,
 * the replacement half banks through the same batch builder `posAdapter.bankSale` uses, and `recordExchange`
 * appends BOTH in one atomic batch — the credit against the bill, its projection and `returned` movements, the
 * replacement sale with its receipt index and `sold` movements, and any store credit for the balance — so the
 * money, the register, the shelf and the report agree or nothing lands. Each event keeps its own idempotency
 * key, so a retried exchange appends once.
 */
export function exchangesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<ExchangeDeps, 'recordAudit'> {
  const returns = returnsAdapter(input);
  const pos = posAdapter(input);
  const bankedSale = async (tenantId: string, saleId: string): Promise<IncomingSale | undefined> => {
    const held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`);
    return held === undefined ? undefined : (held.event.payload as IncomingSale);
  };
  return {
    now: input.now,
    originalSale: returns.originalSale, priorReturns: returns.priorReturns, priorRefunds: returns.priorRefunds,
    refundThreshold: returns.refundThreshold, returnWindow: returns.returnWindow, storeCreditCap: returns.storeCreditCap,
    canApproveRefund: returns.canApproveRefund,
    refundVersion: returns.refundVersion!,
    refundApproval: (tenantId, approvalId) => readRefundApproval(input.store, tenantId, approvalId),
    catalogue: pos.catalogue, currentPackVersion: pos.currentPackVersion, saleHoldingReceipt: pos.saleHoldingReceipt,
    isBanked: pos.isBanked, recordExceptions: pos.recordExceptions,
    bankedSale,
    recordExchange: async (tenantId, originalSaleId, record, replacement, storeCredit, expectedVersion, approvalUses) => {
      // Returned units go back to the location the ORIGINAL sale drew from (the same rule as a plain return);
      // the replacement leaves from the location it declares (the route defaults it to the original's).
      const original = await bankedSale(tenantId, originalSaleId);
      const returnedAt = original === undefined ? undefined : await saleStockLocationOf(input.store, tenantId, original);
      const returnedMovements = returnedAt === undefined ? [] : returnStockMovements(record, returnedAt);
      const soldMovements = saleStockMovements(replacement, await saleStockLocationOf(input.store, tenantId, replacement));
      // Under the bill's refund guard (Wave 2a), with the approval it spends (ADR-0022), in ONE batch.
      await input.store.appendBatch(tenantId, [
        ...returnBatchEvents(tenantId, originalSaleId, record, storeCredit, returnedMovements, returnedAt),
        ...saleBatchEvents(tenantId, replacement, soldMovements),
        ...approvalUseEntries(tenantId, approvalUses, record.processedAt),
      ], expectedVersion === undefined ? undefined : { guard: { key: refundGuardKey(originalSaleId), expectedVersion } });
    },
  };
}

/**
 * OB-82 "A" (owner, 12 Oct 2026, "Fix it once, for good"): till cash and shift closes kept by the till's id ALONE (before
 * OB-80) belong to exactly ONE store, decided ONCE and recorded as an append-only fact — "till X's old records are store S's"
 * (`LegacyTillPlaced`, one idempotency key per till: the first placement stands for ever, nothing ever re-decides it). Reads
 * use ONLY that record — never today's store count, never the device register — so a second store arriving, or the till
 * being registered (at any store) later, never moves, hides or doubles the old float.
 *
 * Who writes it:
 *   • AUTOMATICALLY (`how: 'single_store_rule'`, by "system"), at the FIRST moment head office reads or writes that till's
 *     cash or shift records while it knows exactly ONE store — in the single-store pilot that is the first look after
 *     go-live, before any second store can exist. The stores known at that moment are kept on the record as evidence.
 *   • otherwise by a NAMED head-office person (`POST /v1/tills/:tillId/legacy-placement`, `how: 'head_office'`) — the
 *     remedy for a till whose old records were first looked at when no store, or more than one, was known. Until then the
 *     old records are shown as UNPLACED (P-08), never folded into any store's till of the same name, never dropped.
 * History is never rewritten (hard rule #2): the old records stay on the till's own stream.
 */
export interface LegacyTillPlacement {
  readonly tillId: string;
  readonly storeId: string;
  readonly placedBy: string;
  readonly how: 'single_store_rule' | 'head_office';
  readonly reason: string;
  readonly at: string;
  /** The stores head office knew at the moment it was placed — the evidence for the decision. */
  readonly storesKnown: readonly string[];
  /** OB-86 "A": what made head office place it automatically — the route and the person (absent on older records). */
  readonly triggeredBy?: PlacementTrigger;
}
const LEGACY_TILL_PLACEMENTS = streamName(STREAM.cash, 'legacy-till-placements', 'v1');
/** OB-86 · verifier r17 OB82-1: the store set's write guard — every org-node write and every automatic placement takes it. */
export const ORG_STORES_GUARD = 'org-stores';
const legacyPlacementKey = (tenantId: string, tillId: string): string => `legacy-till-placed-${tenantId}-${tillId}`;

/** The one-time placement of a till's pre-OB-80 records, if it has been made. */
export async function legacyTillPlacement(store: EventStore, tenantId: string, tillId: string): Promise<LegacyTillPlacement | undefined> {
  const held = await store.findByIdempotencyKey(tenantId, legacyPlacementKey(tenantId, tillId));
  return held === undefined ? undefined : (held.event.payload as LegacyTillPlacement);
}

/** Every one-time placement made (for a store's list of tills). */
export async function legacyTillPlacements(store: EventStore, tenantId: string): Promise<readonly LegacyTillPlacement[]> {
  return allOf<LegacyTillPlacement>(store, tenantId, LEGACY_TILL_PLACEMENTS, 'LegacyTillPlaced');
}

/** Record the placement — first one wins (one key per till). Returns the placement that STANDS and whether this call made it. */
export async function placeLegacyTill(store: EventStore, tenantId: string, p: LegacyTillPlacement): Promise<{ readonly placement: LegacyTillPlacement; readonly recorded: boolean }> {
  const res = await store.append(tenantId, LEGACY_TILL_PLACEMENTS, makeEvent({
    id: `legacy-till-placed-${p.tillId}`, type: 'LegacyTillPlaced', occurredAt: p.at,
    idempotencyKey: legacyPlacementKey(tenantId, p.tillId), source: 'api/pos', payload: p,
  }));
  return { placement: res.record.event.payload as LegacyTillPlacement, recorded: !res.deduped };
}

/** Whether a till has anything kept by its id alone: cash on its own stream, or a shift close naming no store. */
async function hasLegacyTillHistory(store: EventStore, tenantId: string, tillId: string): Promise<boolean> {
  if ((await store.readStream(tenantId, forTillCash(tillId), { type: 'CashMovement' })).length > 0) return true;
  return (await allOf<{ tillId: string; storeId?: string }>(store, tenantId, SHIFTS_STREAM, 'TillClosed')).some((c) => c.tillId === tillId && (c.storeId === undefined || c.storeId === ''));
}

/**
 * OB-82: the store a till's pre-OB-80 records belong to — the one-time placement; made automatically here, once, when the
 * till has such records and head office knows exactly one store at this moment. undefined → not placed (shown unplaced).
 */
export async function legacyTillStore(
  input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, tillId: string, trigger?: PlacementTrigger,
): Promise<string | undefined> {
  const placed = await legacyTillPlacement(input.store, tenantId, tillId);
  if (placed !== undefined) return placed.storeId;
  if (!(await hasLegacyTillHistory(input.store, tenantId, tillId))) return undefined;
  const triggeredBy: PlacementTrigger = trigger ?? { route: 'unnamed head-office read', by: 'system' };
  // OB-86 "A" · verifier r17 OB82-1 (c): the one-store fact must be STABLE at the moment of the write. The store set's guard
  // (`ORG_STORES_GUARD`, bumped by every org-node write — the only way a store now comes to exist, since settings need an
  // org node and a role's scope must name a registered store) is read BEFORE the store set, and the placement is appended
  // under it: a store added in between moves the guard, the append is refused by name, and the decision is taken again on
  // the new store set (two stores → not placed, shown unplaced). Never a placement made on a store count already stale.
  for (let attempt = 0; ; attempt += 1) {
    const expectedVersion = await input.store.guardVersion(tenantId, ORG_STORES_GUARD);
    // Read AFTER the guard: a racing read whose placement landed before this point is seen here (its placement stands, no
    // second audit record); one that lands after it moves the guard and refuses our batch, and the next round sees it.
    const raced = await legacyTillPlacement(input.store, tenantId, tillId);
    if (raced !== undefined) return raced.storeId;
    const { knownStores } = await storeOfLocationResolver(input, tenantId);
    if (knownStores.size !== 1) return undefined;
    const only = [...knownStores][0]!;
    const at = input.now();
    const p: LegacyTillPlacement = {
      tillId, storeId: only, placedBy: 'system', how: 'single_store_rule', at, storesKnown: [only], triggeredBy,
      reason: `head office first read or wrote till ${tillId}'s records kept by its id alone (${triggeredBy.route}, by ${triggeredBy.by}) while it knew exactly one store (${only})`,
    };
    // OB-86 "A" · verifier r18 OB86-1: the automatic placement and its M34 audit record (naming what triggered it) are ONE
    // atomic batch — both land or neither does, so a crash can never leave a placement with no audit entry. The batch holds
    // the store set's guard AND the audit chain's: a racing placement, a new store or another audited write in between
    // refuses it by name, and the decision (and the seal) is taken again.
    const audit = await sealedAuditEntry(input.store, tenantId, {
      actorId: 'system', action: 'till.legacy.place', objectType: 'till', objectId: tillId, at,
      origin: { tenantId, branchId: only }, before: null,
      after: { storeId: only, how: 'single_store_rule', storesKnown: only, triggeredByRoute: triggeredBy.route, triggeredBy: triggeredBy.by },
      reason: p.reason, correlationId: tillId,
    });
    let res: AppendResult;
    try {
      [res] = await input.store.appendBatch(tenantId, [{ stream: LEGACY_TILL_PLACEMENTS, event: makeEvent({
        id: `legacy-till-placed-${tillId}`, type: 'LegacyTillPlaced', occurredAt: at,
        idempotencyKey: legacyPlacementKey(tenantId, tillId), source: 'api/pos', payload: p,
      }) }, audit.entry], { guard: { key: ORG_STORES_GUARD, expectedVersion }, alsoGuards: [audit.guard] }) as [AppendResult, AppendResult];
    } catch (e) {
      if (e instanceof ConcurrencyConflictError && attempt < 32) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8 * (attempt + 1))));
        continue;
      }
      throw e;
    }
    return (res.record.event.payload as LegacyTillPlacement).storeId;
  }
}

/** OB-80: the tills head office has kept cash for at a store (since OB-80). */
export async function tillsAtStore(store: EventStore, tenantId: string, storeId: string): Promise<readonly string[]> {
  return [...new Set([
    ...(await allOf<{ tillId: string }>(store, tenantId, forTillsAtStore(storeId), 'TillKeptAtStore')).map((t) => t.tillId),
    // OB-82: a till whose old records were placed at this store, once and for all.
    ...(await legacyTillPlacements(store, tenantId)).filter((p) => p.storeId === storeId).map((p) => p.tillId),
  ])];
}

export function cashAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): CashDeps {
  const read = async (tenantId: string, stream: string): Promise<TillMovement[]> =>
    (await allOf<RecordedCashMovement>(input.store, tenantId, stream, 'CashMovement'))
      .map((m): TillMovement => ({
        movementId: m.movementId, tillId: m.tillId, kind: m.kind, deltaMinor: m.deltaMinor, custodianId: m.custodianId,
        ...(m.laneId === undefined ? {} : { laneId: m.laneId }), ...(m.performedBy === undefined ? {} : { performedBy: m.performedBy }),
        ...(m.relayed === true ? { relayed: true as const } : {}), ...(m.flags === undefined ? {} : { flags: m.flags }),
      }));
  return {
    now: input.now,

    // OB-80: a store's till reads its own chain, preceded by what was kept by the till's id alone when the migration rule
    // places that in the same store (one chain: the custodian and the balance carry over, never double). No store → the
    // chain kept by the till's id alone, exactly as before OB-80.
    // OB-82: the old chain joins ONLY the store its one-time placement names, and the two chains are de-duplicated by movement
    // id — a movement the till re-sent after OB-80 that is already on the old chain counts ONCE.
    tillMovements: async (tenantId, tillId, storeId, trigger) => {
      if (storeId === undefined) return read(tenantId, forTillCash(tillId));
      const legacy = (await legacyTillStore(input, tenantId, tillId, trigger)) === storeId ? await read(tenantId, forTillCash(tillId)) : [];
      const seen = new Set(legacy.map((m) => m.movementId));
      return [...legacy, ...(await read(tenantId, forStoreTillCash(storeId, tillId))).filter((m) => !seen.has(m.movementId))];
    },
    legacyTill: async (tenantId, tillId, trigger) => {
      const store = await legacyTillStore(input, tenantId, tillId, trigger);
      const placement = store === undefined ? undefined : await legacyTillPlacement(input.store, tenantId, tillId);
      return { ...(placement === undefined ? {} : { placement }), movements: await read(tenantId, forTillCash(tillId)), hasHistory: await hasLegacyTillHistory(input.store, tenantId, tillId) };
    },
    placeLegacyTill: async (tenantId, p) => placeLegacyTill(input.store, tenantId, p),
    legacyStoreOfTill: (tenantId, tillId, trigger) => legacyTillStore(input, tenantId, tillId, trigger),
    storeOfTill: (tenantId, tillId) => storeOfLane(input.store, tenantId, tillId),
    knownStores: async (tenantId) => [...(await storeOfLocationResolver(input, tenantId)).knownStores],
    // SP-4c: the custodian / recorder a relayed movement names is re-verified from their grants, never taken on the box's word.
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),

    recordCashMovement: async (tenantId, tillId, m) => {
      if (m.storeId !== undefined) {
        // OB-80: the store's own till — keyed by (store, movement), so another store's movement of the same id is its own
        // record, never a duplicate of this one; and the till is listed at its store in the same atomic write.
        const storeId = m.storeId;
        await input.store.appendBatch(tenantId, [{
          stream: forStoreTillCash(storeId, tillId),
          event: makeEvent({
            id: `cash-${storeId}-${tillId}-${m.movementId}`, type: 'CashMovement', occurredAt: m.at,
            idempotencyKey: `cash-${tenantId}-${storeId}-${tillId}-${m.movementId}`, source: 'api/pos', payload: m,
          }),
        }, {
          stream: forTillsAtStore(storeId),
          event: makeEvent({
            id: `till-kept-at-${storeId}-${tillId}`, type: 'TillKeptAtStore', occurredAt: m.at,
            idempotencyKey: `till-kept-at-${tenantId}-${storeId}-${tillId}`, source: 'api/pos', payload: { storeId, tillId, firstAt: m.at },
          }),
        }]);
        return;
      }
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
  const reviews = (tenantId: string) =>
    allOf<OverShortReview>(input.store, tenantId, SHIFTS_STREAM, 'ShiftOverShortReviewed');
  // The auto-open reuses the SAME loss-prevention case store the manual /cases route writes to, so an
  // auto-opened case is an ordinary case — read, evidenced and closed through the existing surface.
  const lp = lpCasesAdapter({ store: input.store, now: input.now });

  return {
    now: input.now,
    // SP-4c: the cashier a relayed close names is re-verified from their grants, never taken on the box's word.
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    // OB-80: a close is kept per (store, till) — the till's registered store when the close names none.
    storeOfTill: (tenantId, tillId) => storeOfLane(input.store, tenantId, tillId),
    // OB-82: a close kept before OB-80 (no store) belongs to its till's one-time legacy placement.
    legacyStoreOfTill: (tenantId, tillId, trigger) => legacyTillStore(input, tenantId, tillId, trigger),
    knownStores: async (tenantId) => [...(await storeOfLocationResolver(input, tenantId)).knownStores],

    closedShift: async (tenantId, shiftId) => (await closes(tenantId)).find((r) => r.shiftId === shiftId),

    overShortShifts: async (tenantId) => (await closes(tenantId)).filter((r) => r.exceptionRaised),

    overShortReviews: async (tenantId) => reviews(tenantId),

    openInvestigationOnShortage: async (tenantId, record) => {
      // "The store manager" is a role, not a person — resolve who holds it from the tenant's own grants
      // (the authoritative source, the same one the kernel authorizes against), never from the request.
      const grants = await effectiveGrants(input.store, tenantId);
      const storeManagers = [...new Set(grants.filter((g) => g.roleId === STORE_MANAGER_ROLE_ID).map((g) => g.userId))];

      const plan = planInvestigationFromShortage({ shift: record, storeManagers });
      if (!plan.open) return { opened: false, blockedReason: plan.refusedBecause, detail: plan.detail };

      // Idempotent: one case per shift shortage. A re-run finds the case already open and does nothing.
      const existing = await lp.case(tenantId, plan.caseId!);
      if (existing !== undefined) {
        return { opened: true, caseId: existing.caseId, assignedTo: existing.assignedTo, alreadyOpen: true, detail: 'investigation already open for this shift' };
      }

      const result = openCase({
        caseId: plan.caseId!, tenantId, raisedFromRef: plan.raisedFromRef!, subjectRef: plan.subjectRef!,
        summary: plan.summary!, valueMinor: plan.valueMinor!,
        // A deterministic rule opened this, not a person — recorded honestly as the system actor (P-05).
        openedBy: SHORTAGE_RULE_ACTOR, assignedTo: plan.assignedTo!, at: input.now(),
        // OB-235: marked "opened by rule" on the case record — nobody reads it as a person accusing someone.
        openedByRule: plan.openedByRule === true,
      });
      if (!result.opened || result.case === undefined) {
        return { opened: false, blockedReason: 'refused', detail: result.detail };
      }
      await lp.recordOpened(tenantId, result.case);
      return { opened: true, caseId: result.case.caseId, assignedTo: result.case.assignedTo, detail: result.detail };
    },

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

    recordOverShortReview: async (tenantId, review) => {
      await input.store.append(tenantId, SHIFTS_STREAM, makeEvent({
        id: `shift-overshort-review-${review.shiftId}`,
        type: 'ShiftOverShortReviewed',
        occurredAt: review.reviewedAt,
        // One sign-off per shift — a re-sent review collapses rather than recording two findings.
        idempotencyKey: `shift-overshort-review-${tenantId}-${review.shiftId}`,
        source: 'api/pos',
        payload: review,
      }));
    },
  };
}

export function dayCloseAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DayCloseDeps {
  const closes = (tenantId: string) =>
    allOf<DayCloseRecord>(input.store, tenantId, DAY_CLOSE_STREAM, 'StoreDayClosed');
  const reopens = (tenantId: string) =>
    allOf<DayReopenRecord>(input.store, tenantId, DAY_CLOSE_STREAM, 'StoreDayReopened');

  return {
    now: input.now,

    dayClose: async (tenantId, dayCloseId) => (await closes(tenantId)).find((r) => r.dayCloseId === dayCloseId),
    dayReopen: async (tenantId, dayCloseId) => (await reopens(tenantId)).find((r) => r.dayCloseId === dayCloseId),
    dayCloses: async (tenantId) => closes(tenantId),
    dayReopens: async (tenantId) => reopens(tenantId),

    recordDayClose: async (tenantId, record) => {
      await input.store.append(tenantId, DAY_CLOSE_STREAM, makeEvent({
        id: `store-day-close-${record.dayCloseId}`,
        type: 'StoreDayClosed',
        occurredAt: record.closedAt,
        // The day-close's own id — a re-sent close collapses rather than recording one day closed twice.
        idempotencyKey: `store-day-close-${tenantId}-${record.dayCloseId}`,
        source: 'api/pos',
        payload: record,
      }));
    },

    recordDayReopen: async (tenantId, record) => {
      await input.store.append(tenantId, DAY_CLOSE_STREAM, makeEvent({
        id: `store-day-reopen-${record.dayCloseId}`,
        type: 'StoreDayReopened',
        occurredAt: record.reopenedAt,
        // One reopen per day-close id — a re-sent reopen collapses rather than recording two.
        idempotencyKey: `store-day-reopen-${tenantId}-${record.dayCloseId}`,
        source: 'api/pos',
        payload: record,
      }));
    },

    // The §28 authority to APPROVE a day-close reopen (till.dayclose.approve) — resolved from the
    // tenant's own grants (the authoritative source the kernel authorizes against), never the request.
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    canApproveDayReopen: async (tenantId, userId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
      return ROLE_CATALOGUE.some((r) => roleIds.has(r.id) && r.permissions.includes('till.dayclose.approve'));
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

    recordAccount: async (tenantId, customerId, creditLimitMinor, currency, _at, paymentTermsDays) => {
      const terms = paymentTermsDays === undefined ? '' : `-t${paymentTermsDays}`;
      const payload = { creditLimitMinor, currency, ...(paymentTermsDays === undefined ? {} : { paymentTermsDays }) } satisfies B2BAccount;
      // Keyed on the values AND the limit they supersede (hard rule #10, verifier r18): the same limit (and terms) in force
      // collapses; a different one — including back to an earlier one — is a new, latest fact.
      await appendSetting(input.store, tenantId, forB2BCustomer(customerId), {
        type: 'B2BCreditLimitSet', idPrefix: `b2b-limit-${customerId}`, valueKey: `b2b-limit-${tenantId}-${customerId}-${creditLimitMinor}${terms}`,
        occurredAt: input.now(), source: 'api/finance', payload,
        sameValue: (p) => { const a = p as B2BAccount; return a.creditLimitMinor === creditLimitMinor && a.currency === currency && a.paymentTermsDays === paymentTermsDays; },
      });
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

    // Manual records + the till's docket tags (M27-FR-03) — a sale the desk recorded by hand keeps its
    // record; the tags fill in every other receipt, so settlement sees the counter without re-keying.
    sales: async (tenantId, contractId) => {
      const manual = await allOf<ConcessionSale>(input.store, tenantId, forConcession(contractId), 'ConcessionSaleRecorded');
      const tags = await latestConcessionTags(input.store, tenantId, contractId);
      return [...manual, ...tagsAsConcessionSales(tags, { excludeSaleIds: new Set(manual.map((x) => x.saleId)) })];
    },

    recordContract: async (tenantId, contract) => {
      // Keyed on the terms — re-sending the same contract collapses, a change of terms is a new fact.
      // The eligibility terms (insurance/licence/approver) are in the key too, so renewing insurance or
      // approving the contract is a new version the eligibility gate reads.
      const key = `concession-contract-${tenantId}-${contract.contractId}-${contract.basis}-${contract.fixedRentMinor ?? 0}-${contract.revenueShareBps ?? 0}-${contract.depositMinor}-${contract.active}-${contract.insuranceUntil ?? 'none'}-${contract.licenceUntil ?? 'none'}-${contract.approvedBy ?? 'unapproved'}`;
      await input.store.append(tenantId, forConcession(contract.contractId), makeEvent({
        // Each VERSION has its own id, derived from its key (2b-vi-b-2). Before, the id named only the money terms, so
        // approving a contract recorded unapproved — the normal two-person path now — collided with the first version's
        // id on PostgreSQL (a 500) instead of landing as the new version.
        id: `concession-contract-${contract.contractId}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        type: 'ConcessionContractSet',
        occurredAt: input.now(),
        idempotencyKey: key,
        source: 'api/finance',
        payload: contract,
      }));
      // Index it once by partner (M27-FR-03 hop): a tag relayed from the till names the partner, not the contract.
      await input.store.append(tenantId, CONCESSION_CONTRACT_INDEX, makeEvent({
        id: `concession-contract-index-${contract.contractId}`,
        type: 'ConcessionContractIndexed',
        occurredAt: input.now(),
        idempotencyKey: `concession-contract-index-${tenantId}-${contract.contractId}`,
        source: 'api/finance',
        payload: { contractId: contract.contractId, concessionaireId: contract.concessionaireId, branchId: contract.branchId },
      }));
    },

    depositMovements: async (tenantId, concessionaireId) =>
      allOf<DepositMovement>(input.store, tenantId, forConcessionaire(concessionaireId), 'ConcessionDepositMoved'),

    /**
     * The branch's stock, valued at weighted-average cost and SPLIT by owner (M27-FR-02), folded
     * from the same M08 movement ledger as on-hand and valuation. Each ownership pool is valued
     * SEPARATELY — a concessionaire's gold cost is never averaged into the store's rice — then
     * `splitStoreValuation` reports what the store owns and names what it does not. Reads the
     * append-only ledger; writes nothing.
     */
    storeValuation: async (tenantId, branchId) => {
      const events = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
      const movements = events
        .map((e) => payloadOf<Movement>(e))
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

      const groups = new Map<string, Movement[]>();
      for (const m of movements) {
        const ownership: StockOwnership = m.ownership ?? 'own';
        const ownerId = ownership === 'own' ? 'store' : (m.ownerId ?? 'unknown');
        const key = `${ownership}\u001f${ownerId}`;
        groups.set(key, [...(groups.get(key) ?? []), m]);
      }

      const rows: OwnedStockValue[] = [];
      for (const [key, ms] of groups) {
        const [ownership, ownerId] = key.split('\u001f') as [StockOwnership, string];
        const valued = weightedAverageValuation(
          ms.map((m): ValuationMovement => ({
            productId: m.productId, locationId: m.locationId,
            effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor,
            isPurchaseReceipt: carriesCost(m), isTransferOut: movesValueOnward(m.kind), minorPerUnit: minorPerUnitOf(m.uom), ...(m.unitCostPer === undefined ? {} : { costPerUnits: m.unitCostPer }), ...(m.kind === 'opening_reversed' ? { isReceiptReversal: true, ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }) } : {}),
            ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }),
          })),
          'INR',
        );
        for (const v of valued) {
          rows.push({
            productId: v.productId, locationId: v.locationId,
            ownership, ownerId, valueMinor: v.value.minor, onHandMinor: v.onHandMinor,
          });
        }
      }
      return splitStoreValuation({ branchId, rows });
    },

    recordDepositMovement: async (tenantId, movement) => {
      await input.store.append(tenantId, forConcessionaire(movement.concessionaireId), makeEvent({
        id: `concession-deposit-${movement.concessionaireId}-${movement.movementId}`,
        type: 'ConcessionDepositMoved',
        occurredAt: movement.at,
        // The movement's own id — a re-sent deposit movement collapses rather than double-counting the
        // concessionaire's money (a liability the shop owes back).
        idempotencyKey: `concession-deposit-${tenantId}-${movement.concessionaireId}-${movement.movementId}`,
        source: 'api/finance',
        payload: movement,
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
        } else if (e.event.type === 'FacilitiesTaskVerified') {
          // The second person's act (Wave 2b · PA-03) lands on the completion it verifies.
          const id = p['taskId'] as string;
          const current = byId.get(id);
          if (current !== undefined) byId.set(id, { ...current, verifiedBy: p['verifiedBy'] as string });
        }
      }
      return [...byId.values()];
    },

    recordSchedule: async (tenantId, schedule) => {
      const v = (s: typeof schedule): string => `${s.category}-${s.frequency}-${s.evidenceRequired}-${s.verificationRequired}-${s.active}`;
      // Keyed on the definition AND the one it supersedes (hard rule #10, verifier r18): the definition in force collapses;
      // a change — including back to an earlier definition (re-activating) — is a new, latest fact.
      await appendSetting(input.store, tenantId, STREAM.facilities, {
        type: 'FacilitiesScheduleSet', idPrefix: `fac-sched-${schedule.scheduleId}`, valueKey: `fac-sched-${tenantId}-${schedule.scheduleId}-${v(schedule)}`,
        occurredAt: input.now(), source: 'api/platform', payload: schedule,
        sameSubject: (p) => (p as typeof schedule).scheduleId === schedule.scheduleId,
        subjectKey: schedule.scheduleId,
        sameValue: (p) => v(p as typeof schedule) === v(schedule),
      });
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

    recordTaskVerified: async (tenantId, verification) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-task-verified-${verification.taskId}`,
        type: 'FacilitiesTaskVerified',
        occurredAt: verification.at,
        // One verification per task — a re-send collapses; a different verifier after the first changes nothing.
        idempotencyKey: `fac-task-verified-${tenantId}-${verification.taskId}`,
        source: 'api/platform',
        payload: verification,
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
      const v = (a: typeof asset): string => `${a.criticality}-${a.amcUntil ?? 'none'}-${a.warrantyUntil ?? 'none'}-${a.serviceEveryDays ?? 'none'}-${a.protectsValueMinor ?? 'none'}-${a.active}`;
      // Keyed on the fields that matter AND the record it supersedes (hard rule #10, verifier r18): restating the asset in
      // force collapses; a change (renewed AMC, new criticality, retired — or back again) is a new, latest fact.
      await appendSetting(input.store, tenantId, STREAM.facilities, {
        type: 'FacilitiesAssetSet', idPrefix: `fac-asset-${asset.assetId}`, valueKey: `fac-asset-${tenantId}-${asset.assetId}-${v(asset)}`,
        occurredAt: input.now(), source: 'api/platform', payload: asset,
        sameSubject: (p) => (p as typeof asset).assetId === asset.assetId,
        subjectKey: asset.assetId,
        sameValue: (p) => v(p as typeof asset) === v(asset),
      });
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
  const qualityHolds = qualityHoldAdapter({ store: input.store, now: input.now });
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
      const v = (r: typeof reg): string => `${r.range.minTenthsC}-${r.range.maxTenthsC}-${r.range.graceMinutes}-${r.range.expectEveryMinutes ?? 'def'}-${r.onBackup}`;
      // Keyed on the fields that matter AND the range it supersedes (hard rule #10, verifier r18): restating collapses; a
      // change — including back to an earlier range — is a new, latest fact.
      await appendSetting(input.store, tenantId, STREAM.facilities, {
        type: 'FacilitiesEquipmentRangeSet', idPrefix: `fac-range-${reg.assetId}`, valueKey: `fac-range-${tenantId}-${reg.assetId}-${v(reg)}`,
        occurredAt: input.now(), source: 'api/platform', payload: reg,
        sameSubject: (p) => (p as typeof reg).assetId === reg.assetId,
        subjectKey: reg.assetId,
        sameValue: (p) => v(p as typeof reg) === v(reg),
      });
    },

    // PA-07: the reading and the quality holds its breach causes are ONE atomic write.
    recordReading: async (tenantId, reading, holds = []) => {
      const now = input.now();
      await input.store.appendBatch(tenantId, [
        {
          stream: STREAM.facilities,
          event: makeEvent({
            id: `fac-eqreading-${reading.readingId}`,
            type: 'FacilitiesEquipmentReading',
            occurredAt: now,
            idempotencyKey: `fac-eqreading-${tenantId}-${reading.readingId}`,
            source: 'api/platform',
            payload: reading,
          }),
        },
        ...holds.map((h) => qualityHeldEntry(tenantId, h, equipmentHoldKey(h), now)),
      ]);
    },

    qualityHold: async (tenantId, batchId) => qualityHolds.hold(tenantId, batchId),

    recordHolds: async (tenantId, holds) => {
      const now = input.now();
      await input.store.appendBatch(tenantId, holds.map((h) => qualityHeldEntry(tenantId, h, equipmentHoldKey(h), now)));
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
      const v = (c: typeof coverage): string => c.expected.map((e) => `${e.branchId}:${e.departmentId}`).sort().join(',');
      // Keyed on the expected set AND the one it supersedes (hard rule #10, verifier r18): re-sending the expectation in
      // force collapses; a change — including back to an earlier set — is a new, latest fact.
      await appendSetting(input.store, tenantId, STREAM.waste, {
        type: 'WasteCoverageSet', idPrefix: 'waste-coverage', valueKey: `waste-coverage-${tenantId}-${v(coverage)}`,
        occurredAt: input.now(), source: 'api/inventory', payload: coverage,
        sameValue: (p) => v(p as typeof coverage) === v(coverage),
      });
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
      const v = (e: typeof entry): string => `${e.vendor}-${e.model}-${e.versions.join('.')}-${e.rbiAuthorised ?? 'na'}`;
      // Keyed on the entry AND the one it supersedes (hard rule #10, verifier r18): the entry in force collapses; a change —
      // including back to an earlier entry — is a new, latest fact (the fixed id used to refuse every change).
      await appendSetting(input.store, tenantId, STREAM.integration, {
        type: 'IntegrationMatrixEntrySet', idPrefix: `intg-matrix-${entry.entryId}`, valueKey: `intg-matrix-${tenantId}-${entry.entryId}-${v(entry)}`,
        occurredAt: input.now(), source: 'api/platform', payload: entry,
        sameSubject: (p) => (p as typeof entry).entryId === entry.entryId,
        subjectKey: entry.entryId,
        sameValue: (p) => v(p as typeof entry) === v(entry),
      });
    },

    recordAdapter: async (tenantId, config) => {
      // OB-170: registering an adapter again with a change (a payment adapter declaring its India region) is a new, latest
      // fact keyed on what it supersedes — the old registration is kept (append-only), never rewritten. The same
      // configuration again writes nothing. (A fixed event id here refused every change with an id clash.)
      const v = (c: AdapterConfig): string => JSON.stringify([c.category, c.vendor, c.environment, c.credentialRef, c.enabled,
        [...(c.retains ?? [])], c.queueOnOutage ?? null, c.dataRegion ?? null]);
      await appendSetting(input.store, tenantId, STREAM.integration, {
        type: 'IntegrationAdapterRegistered', idPrefix: `intg-adapter-${config.adapterId}`,
        valueKey: `intg-adapter-${tenantId}-${config.adapterId}-${config.environment}-${config.credentialRef}-${config.enabled}${config.dataRegion === undefined ? '' : `-${config.dataRegion}`}`,
        occurredAt: input.now(), source: 'api/platform', payload: config,
        sameSubject: (p) => (p as AdapterConfig).adapterId === config.adapterId,
        subjectKey: config.adapterId,
        sameValue: (p) => v(p as AdapterConfig) === v(config),
      });
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
      // Hard rule #10 (verifier r18): the values AND the config they supersede — a change (and a change back) is a new,
      // latest fact; its id follows the key (the fixed id used to refuse every change after the first).
      const v = (c: typeof config): string => `${c.signingKeyRef}-${c.maxAgeSeconds ?? 'def'}`;
      await appendSetting(input.store, tenantId, forWebhook(config.provider), {
        type: 'WebhookConfigured', idPrefix: `wh-config-${config.provider}`, valueKey: `wh-config-${tenantId}-${config.provider}-${v(config)}`,
        occurredAt: input.now(), source: 'api/platform', payload: config,
        sameValue: (p) => v(p as typeof config) === v(config),
      });
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
      await indexConnector(input.store, tenantId, mapping.connectorId, input.now());
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

/**
 * Connector delivery-queue store (M32-FR-02). Each enqueue / delivery / failure is an append-only
 * `ConnectorDelivery` fact on that connector's own stream; the current queue is the tested
 * `@sre/integration` engine (`drainConnector`) replayed over them — the retry-then-dead-letter state
 * machine runs once, in the fold, and a dead-lettered message is kept, never dropped (hard rule #6).
 */
export function connectorDeliveryAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ConnectorDeliveryDeps {
  return {
    now: input.now,
    // Replay is tenant-agnostic (the stream is already tenant-scoped); stamp the request's tenant back onto
    // each message so the read carries it (and satisfies the cross-tenant response backstop, OB-01).
    queue: async (tenantId, connectorId) =>
      replayConnectorQueue(await allOf<ConnectorDeliveryEvent>(input.store, tenantId, forConnectorDelivery(connectorId), 'ConnectorDelivery'))
        .map((m) => ({ ...m, tenantId })),
    record: async (tenantId, connectorId, event, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await indexConnector(input.store, tenantId, connectorId, event.at);
      await input.store.append(tenantId, forConnectorDelivery(connectorId), makeEvent({
        id: `conn-dq-${event.change}-${event.id}-${d}`,
        type: 'ConnectorDelivery',
        occurredAt: event.at,
        idempotencyKey: `conn-dq-${tenantId}-${connectorId}-${event.change}-${event.id}-${d}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

/**
 * The managed-secrets store (M32-FR-03) — references only, never a value. Registration, rotation and
 * revocation each append the secret's new state; the latest event per secret id is its current state
 * (a rotation supersedes with a new active version, a revocation marks it revoked — hard rule #2/#4).
 */
export function secretsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SecretsDeps {
  const foldLatest = async (tenantId: string): Promise<Map<string, SecretRef>> => {
    const events = await input.store.readStream(tenantId, SECRETS_STREAM, { type: 'SecretStateRecorded' });
    const byId = new Map<string, SecretRef>();
    for (const e of events) {
      const s = payloadOf<SecretRef>(e);
      byId.set(s.secretId, s); // occurrence order → the latest state of a secret wins
    }
    return byId;
  };
  return {
    now: input.now,
    secret: async (tenantId, secretId) => (await foldLatest(tenantId)).get(secretId),
    all: async (tenantId) => [...(await foldLatest(tenantId)).values()],
    record: async (tenantId, secret) => {
      await input.store.append(tenantId, SECRETS_STREAM, makeEvent({
        id: `secret-${secret.secretId}-v${secret.version}-${secret.state}`,
        type: 'SecretStateRecorded',
        occurredAt: input.now(),
        // Keyed on the id + version + state + ref: a re-sent identical state collapses, a rotation
        // (new version) or a revocation (new state) is a new fact. Never the value — there isn't one.
        idempotencyKey: `secret-${tenantId}-${secret.secretId}-v${secret.version}-${secret.state}-${secret.vaultRef}`,
        source: 'api/platform',
        payload: secret,
      }));
    },
  };
}

/**
 * The durable domain audit trail (M34-FR-01) — where a sensitive action is SEALED into a tamper-evident
 * chain and read back as evidence. `recordAudit` seals on the tested `@sre/audit` engine SERVER-SIDE:
 * it folds the current chain, lets `AuditTrail.record` compute this record's sequence + previous-hash
 * from the real tail (the caller NEVER supplies a seal, so a record cannot be forged into the chain),
 * and appends it append-only (`AuditRecordSealed`, never folded — every record is its own fact, hard
 * rule #6). `records` returns the whole chain in order for search / reconstruct / verify. The seal uses
 * the engine's default hasher — the SAME one the read routes verify with — so a stored chain checks out.
 *
 * Sealing folds the tail then appends, so the read of the tail and the write of the next record must not
 * interleave with another record for the same tenant, or two records seal the same sequence and fork the
 * chain. That whole step runs under a PER-TENANT in-process lock (`serialiseByTenant`): concurrent
 * requests to one API instance seal one at a time, different tenants never contend. This closes the fork
 * for a single instance (the shop's cloud API); a multi-instance deployment would add a database-level
 * lock the way the kernel's request-level audit sink does — the generic EventStore has no conditional
 * append to hang optimistic concurrency on. Either way a fork, were it ever to happen, is DETECTED by
 * `verify` (a sequence gap / broken link), never silently wrong (P-08); and the route producers are
 * idempotent, so a retry never double-records.
 */
export interface AuditTrailDeps {
  readonly records: (tenantId: string) => Promise<readonly AuditRecord[]>;
  readonly recordAudit: (tenantId: string, entry: AuditEntry) => Promise<AuditRecord>;
}

/** The write-guard key of a tenant's domain audit chain (Wave 2a · PA-11): one chain, one key, however many API instances. */
const AUDIT_CHAIN_GUARD = 'audit-chain';
/** How many lost rounds one audit write tolerates before it is reported as a named concurrency failure. */
const AUDIT_CHAIN_RETRIES = 32;

/**
 * Verifier r18 OB86-1: an audit record sealed over the chain's CURRENT tail, as a batch entry — for a write that must land
 * TOGETHER with its audit record (one atomic batch: both or neither). The caller appends it with the chain's guard (the
 * version read here) beside its own; a chain that moved in between refuses the batch by name and the caller seals again.
 */
async function sealedAuditEntry(store: EventStore, tenantId: string, entry: AuditEntry): Promise<{
  readonly entry: { readonly stream: string; readonly event: ReturnType<typeof makeEvent> };
  readonly guard: { readonly key: string; readonly expectedVersion: number };
}> {
  const expectedVersion = await store.guardVersion(tenantId, AUDIT_CHAIN_GUARD);
  const seed = new InMemoryAuditStore();
  const tail = await store.latestOfType(tenantId, AUDIT_TRAIL_STREAM, 'AuditRecordSealed');
  if (tail !== undefined) seed.append(payloadOf<AuditRecord>(tail));
  const sealed = new AuditTrail(seed).record(entry);
  return {
    entry: { stream: AUDIT_TRAIL_STREAM, event: makeEvent({
      id: `audit-${sealed.sequence}-${sealed.hash}`, type: 'AuditRecordSealed', occurredAt: sealed.at,
      idempotencyKey: `audit-${tenantId}-${sealed.sequence}-${sealed.hash}`, source: 'api/audit', payload: sealed,
    }) },
    guard: { key: AUDIT_CHAIN_GUARD, expectedVersion },
  };
}

export function auditTrailAdapter(input: { readonly store: EventStore }): AuditTrailDeps {
  const records = (tenantId: string) =>
    allOf<AuditRecord>(input.store, tenantId, AUDIT_TRAIL_STREAM, 'AuditRecordSealed');
  // A per-tenant promise chain: each task runs only after the previous one for that tenant has settled,
  // so the fold-tail-then-append is atomic per tenant. A thrown task does not poison the chain (the tail
  // stored is `.catch`-guarded), and the caller still sees the real result or error.
  const tails = new Map<string, Promise<unknown>>();
  const serialiseByTenant = <T>(tenantId: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(tenantId) ?? Promise.resolve()).then(task, task);
    tails.set(tenantId, run.catch(() => undefined));
    return run;
  };
  return {
    records,
    recordAudit: (tenantId, entry) => serialiseByTenant(tenantId, async () => {
      // Across INSTANCES (Wave 2a · audit PA-11): the promise chain above serialises one process; the tenant's chain
      // guard serialises them all. The tail is folded and the seal appended under the guard's version; a second API
      // instance that sealed over the same tail a moment earlier has moved it, this append is refused by name, and
      // the chain is folded again over the new tail — never two records with one sequence, never a fork.
      for (let attempt = 0; ; attempt += 1) {
        const expectedVersion = await input.store.guardVersion(tenantId, AUDIT_CHAIN_GUARD);
        // The seal needs only the TAIL (the engine reads `last()` for the sequence and the previous hash), so only the tail
        // is read — one indexed row, not the whole chain (GT-05: a store-volume load seals thousands of records, and
        // re-reading the chain for each made every audited write slower than the last).
        const seed = new InMemoryAuditStore();
        const tail = await input.store.latestOfType(tenantId, AUDIT_TRAIL_STREAM, 'AuditRecordSealed');
        if (tail !== undefined) seed.append(payloadOf<AuditRecord>(tail));
        // The engine validates the entry (an unattributable record is refused) and seals it over the tail.
        const sealed = new AuditTrail(seed).record(entry);
        try {
          await input.store.appendBatch(tenantId, [{ stream: AUDIT_TRAIL_STREAM, event: makeEvent({
            id: `audit-${sealed.sequence}-${sealed.hash}`,
            type: 'AuditRecordSealed',
            occurredAt: sealed.at,
            // One record per (sequence, hash): the seal is unique, so an identical re-send collapses and a
            // genuinely new action is a new fact. Never overwritten, never folded away (hard rule #6).
            idempotencyKey: `audit-${tenantId}-${sealed.sequence}-${sealed.hash}`,
            source: 'api/audit',
            payload: sealed,
          }) }], { guard: { key: AUDIT_CHAIN_GUARD, expectedVersion } });
          return sealed;
        } catch (err) {
          if (!(err instanceof ConcurrencyConflictError) || attempt >= AUDIT_CHAIN_RETRIES) throw err;
          // A short random pause before folding again. Two instances that lose and retry in lockstep would otherwise
          // keep losing to each other (seen on PostgreSQL: one writer lost nine rounds running); the jitter breaks
          // the step, so each round has a winner AND the loser wins soon after.
          await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8 * (attempt + 1))));
        }
      }
    }),
  };
}

/**
 * The org-structure store (M01-FR-01) — the skeleton every transaction is scoped to. Nodes are latest
 * per node id (a company/branch/warehouse/department can be edited and activated; append-only, hard rule
 * #2); GST registrations are one per GSTIN. The hierarchy rules run in the route on the tested engine.
 */
/** An org node as one canonical string (its fields in name order) — what "the same node" means for PA-05. */
const nodeJson = (n: OrgNode): string => JSON.stringify(Object.keys(n).sort().map((k) => [k, (n as unknown as Record<string, unknown>)[k]]));

/**
 * The next version of an org node, as a batch entry — or undefined when exactly that is already held (nothing to record).
 * One rule for every writer of a node (the org register's routes, and a governed branch transition, PA-04), so a node's
 * versions never fork.
 */
export async function orgNodeVersionEntry(store: EventStore, tenantId: string, node: OrgNode, at: string): Promise<BatchEntry | undefined> {
  const versions = (await store.readStream(tenantId, ORG_NODES_STREAM, { type: 'OrgNodeSet' }))
    .map((e) => payloadOf<OrgNode>(e)).filter((n) => n.nodeId === node.nodeId);
  const held = versions[versions.length - 1];
  if (held !== undefined && nodeJson(held) === nodeJson(node)) return undefined;
  const version = versions.length + 1;
  const digest = createHash('sha256').update(nodeJson(node)).digest('hex').slice(0, 16);
  return {
    stream: ORG_NODES_STREAM,
    event: makeEvent({
      id: `org-node-${node.nodeId}-v${version}`,
      type: 'OrgNodeSet',
      occurredAt: at,
      idempotencyKey: `org-node-${tenantId}-${node.nodeId}-v${version}-${digest}`,
      source: 'api/platform',
      payload: node,
    }),
  };
}

export function orgStructureAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): OrgStructureDeps {
  const foldNodes = async (tenantId: string): Promise<OrgNode[]> => {
    const events = await input.store.readStream(tenantId, ORG_NODES_STREAM, { type: 'OrgNodeSet' });
    const byId = new Map<string, OrgNode>();
    for (const e of events) {
      const n = payloadOf<OrgNode>(e);
      byId.set(n.nodeId, n); // occurrence order → the latest state of a node wins
    }
    return [...byId.values()];
  };
  return {
    now: input.now,
    nodes: (tenantId) => foldNodes(tenantId),
    registrations: async (tenantId) => {
      const events = await input.store.readStream(tenantId, ORG_REGISTRATIONS_STREAM, { type: 'OrgGstRegistered' });
      const byGstin = new Map<string, GstRegistration>();
      for (const e of events) {
        const r = payloadOf<GstRegistration>(e);
        byGstin.set(r.gstin, r); // one registration per GSTIN
      }
      return [...byGstin.values()];
    },
    recordNode: async (tenantId, node) => {
      // Audit PA-05: the key used to be the node's STRUCTURE (kind, parent, company, GSTIN, status) without its name, so a
      // rename collapsed into the earlier record as a "duplicate" — the route said 201 and the old name stayed. Now:
      // exactly what is held already → nothing to record; anything else (a rename, a rename BACK, an activation) is a new
      // version of the node, keyed on its version number and its whole content. The latest-wins fold reads it.
      const entry = await orgNodeVersionEntry(input.store, tenantId, node, input.now());
      // OB-86 · verifier r17 OB82-1 (c): every org-node write moves the store set's guard, so an automatic one-store decision
      // racing a store being added is refused and re-taken (legacyTillStore). A lost round is read again and re-sent.
      if (entry !== undefined) {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await input.store.appendBatch(tenantId, [entry], { guard: { key: ORG_STORES_GUARD, expectedVersion: await input.store.guardVersion(tenantId, ORG_STORES_GUARD) } });
            break;
          } catch (e) {
            if (!(e instanceof ConcurrencyConflictError) || attempt >= 16) throw e;
          }
        }
      }
    },
    recordRegistration: async (tenantId, registration) => {
      await input.store.append(tenantId, ORG_REGISTRATIONS_STREAM, makeEvent({
        id: `org-gst-${registration.gstin}`,
        type: 'OrgGstRegistered',
        occurredAt: input.now(),
        // One GSTIN, one registration — keyed on the GSTIN so a re-send collapses (the route already
        // refuses a duplicate against a DIFFERENT company).
        idempotencyKey: `org-gst-${tenantId}-${registration.gstin}`,
        source: 'api/platform',
        payload: registration,
      }));
    },
  };
}

/**
 * The shelf-count store (M04-FR-02/03) — APPEND-ONLY observations. A recount is a NEW row and the
 * previous one stays (it is the record that explains a variance); the engine folds latest-per-facing for
 * the reads. Idempotent on the count id so a re-synced observation is one row, not two.
 */
const forMerchandising = (storeId: string): string => streamName(STREAM.inventory, 'merchandising', storeId);

/** The shelf map and planograms a store keeps (M04-FR-02/03, un-parks CH-02): versioned, append-only, per store. */
export function planogramStoreAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PlanogramStoreDeps {
  return {
    now: input.now,
    shelfMap: async (tenantId, storeId) => {
      const all = await allOf<StoredShelfMap>(input.store, tenantId, forMerchandising(storeId), 'ShelfMapPublished');
      return all.reduce<StoredShelfMap | undefined>((best, m) => (best === undefined || m.version > best.version ? m : best), undefined);
    },
    planograms: (tenantId, storeId) => allOf<StoredPlanogram>(input.store, tenantId, forMerchandising(storeId), 'PlanogramPublished'),
    recordShelfMap: async (tenantId, map) => {
      await input.store.append(tenantId, forMerchandising(map.storeId), makeEvent({
        id: `shelf-map-${map.storeId}-v${map.version}`, type: 'ShelfMapPublished', occurredAt: map.publishedAt,
        // Keyed on the version: a retry of the same publish collapses; the next publish is the next version.
        idempotencyKey: `shelf-map-${tenantId}-${map.storeId}-v${map.version}`, source: 'api/inventory', payload: map,
      }));
    },
    recordPlanogram: async (tenantId, planogram) => {
      await input.store.append(tenantId, forMerchandising(planogram.storeId), makeEvent({
        id: `planogram-${planogram.storeId}-${planogram.planogramId}-v${planogram.version}`, type: 'PlanogramPublished', occurredAt: planogram.publishedAt,
        idempotencyKey: `planogram-${tenantId}-${planogram.storeId}-${planogram.planogramId}-v${planogram.version}`, source: 'api/inventory', payload: planogram,
      }));
    },
  };
}

export function shelfCountAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ShelfCountDeps {
  const planograms = planogramStoreAdapter(input);
  return {
    now: input.now,
    counts: (tenantId, storeId) => allOf<StoredShelfCount>(input.store, tenantId, forShelfCounts(storeId), 'ShelfCountRecorded'),
    // SP-8c-ii: a RELAYED count's counter is re-verified from their own grants, and judged against the shelf map head
    // office itself published for the store (the device's list only when there is none — and that is flagged).
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    knownShelves: async (tenantId, storeId) => (await planograms.shelfMap(tenantId, storeId))?.locations.map((l) => l.locationId),
    recordCount: async (tenantId, countId, count) => {
      await input.store.append(tenantId, forShelfCounts(count.storeId), makeEvent({
        id: `shelf-count-${count.storeId}-${countId}`,
        type: 'ShelfCountRecorded',
        occurredAt: count.at,
        // Keyed on the count id: a re-sync of the same observation collapses; a genuine recount is a new
        // countId and stays alongside the earlier one (append-only, hard rule #2).
        idempotencyKey: `shelf-count-${tenantId}-${count.storeId}-${countId}`,
        source: 'api/inventory',
        payload: count,
      }));
    },
  };
}

export function spacePerformanceAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SpacePerformanceDeps {
  return {
    now: input.now,
    // Folded latest-per-contractId by append order — a re-recorded contract (a correction) supersedes.
    contracts: async (tenantId) => {
      const all = await allOf<DisplayContract>(input.store, tenantId, DISPLAY_CONTRACT_STREAM, 'DisplayContractRecorded');
      const byId = new Map<string, DisplayContract>();
      for (const c of all) byId.set(c.contractId, c);
      return [...byId.values()];
    },
    recordContract: async (tenantId, contractId, contract, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, DISPLAY_CONTRACT_STREAM, makeEvent({
        id: `display-contract-${contractId}-${d}`,
        type: 'DisplayContractRecorded',
        occurredAt: input.now(),
        idempotencyKey: `display-contract-${tenantId}-${contractId}-${d}`,
        source: 'api/inventory',
        payload: contract,
      }));
    },
  };
}

export function drillThroughAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DrillThroughDeps {
  return {
    now: input.now,
    // Append-only — every drill is its own record; the audit is never overwritten or folded.
    audits: (tenantId) => allOf<DrillAudit>(input.store, tenantId, DRILL_AUDIT_STREAM, 'DrillAudited'),
    recordAudit: async (tenantId, audit, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, DRILL_AUDIT_STREAM, makeEvent({
        id: `drill-audit-${d}`,
        type: 'DrillAudited',
        occurredAt: audit.at,
        idempotencyKey: `drill-audit-${tenantId}-${d}`,
        source: 'api/reporting',
        payload: audit,
      }));
    },
  };
}

export function delegationAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DelegationDeps {
  return {
    now: input.now,
    // WHERE a person holds an authority (Wave 2b · PA-03): the branches of the grants that carry it.
    branchScopeOfUser: async (tenantId, userId, permission) => {
      const grants = await effectiveGrants(input.store, tenantId);
      if (!grants.some((g) => g.userId === userId)) return undefined;
      return new AccessControl(ROLE_CATALOGUE, grants).branchScopeOf(userId, permission);
    },
    // Folded latest-per-delegationId by append order — a revocation (a re-record with revokedOn) supersedes.
    delegations: async (tenantId) => {
      const all = await allOf<Delegation>(input.store, tenantId, DELEGATION_STREAM, 'DelegationRecorded');
      const byId = new Map<string, Delegation>();
      for (const d of all) byId.set(d.delegationId, d);
      return [...byId.values()];
    },
    recordDelegation: async (tenantId, delegation, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, DELEGATION_STREAM, makeEvent({
        id: `delegation-${delegation.delegationId}-${d}`,
        type: 'DelegationRecorded',
        occurredAt: input.now(),
        idempotencyKey: `delegation-${tenantId}-${delegation.delegationId}-${d}`,
        source: 'api/identity',
        payload: delegation,
      }));
    },
  };
}

/** The decisions register (SP-2a): every approval decided at a store and relayed here, on its own identity stream. */
const APPROVAL_DECISIONS_STREAM = streamName(STREAM.identity, 'approval-decisions');

/**
 * The permissions a user genuinely holds in a tenant — from their grants and the role catalogue, never from a body.
 * `undefined` when they hold no grant at all (an unknown name), which the synced routes record as its own flag (§28).
 */
export async function permissionsHeldBy(store: EventStore, tenantId: string, userId: string): Promise<readonly string[] | undefined> {
  const grants = await effectiveGrants(store, tenantId);
  const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
  if (roleIds.size === 0) return undefined;
  return [...new Set(ROLE_CATALOGUE.filter((r) => roleIds.has(r.id)).flatMap((r) => r.permissions))];
}

/**
 * Does this M08 movement carry its OWN cost basis into the valuation (SP-5 · F05)? A purchase receipt does; so does a
 * `transferred_in` that arrived with the sending location's unit cost recorded at dispatch — the value that left the
 * source is the value that enters the destination. Every valuation reader maps through this ONE rule.
 */
const carriesCost = (m: Movement): boolean => m.kind === 'received'
  || ((m.kind === 'transferred_in' || m.kind === 'produced') && m.unitCostMinor !== undefined); // FUL-01: a released batch enters at the run's cost

/**
 * The cloud's own unit cost for a product (SP-2b · F07): the weighted average of what it cost to buy, folded from the
 * `received` movements that carried a cost, across locations; failing that, the production cost register; failing
 * that `undefined` — said, never a silent zero.
 */
async function unitCostHeldFor(store: EventStore, tenantId: string, productId: string): Promise<number | undefined> {
  const moves = (await store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' }))
    .map((e) => payloadOf<Movement>(e))
    .filter((m) => m.productId === productId)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const rows = weightedAverageValuation(
    moves.map((m): ValuationMovement => ({
      productId: m.productId, locationId: m.locationId, effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor,
      isPurchaseReceipt: carriesCost(m), isTransferOut: movesValueOnward(m.kind), minorPerUnit: minorPerUnitOf(m.uom), ...(m.unitCostPer === undefined ? {} : { costPerUnits: m.unitCostPer }), ...(m.kind === 'opening_reversed' ? { isReceiptReversal: true, ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }) } : {}),
      ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }),
    })),
    'INR',
  );
  let valued = 0;
  let value = 0;
  for (const r of rows) {
    if (r.unitCostMinor === 'not_known' || r.onHandMinor <= 0) continue;
    valued += r.onHandMinor;
    value += r.value.minor;
  }
  // OB-31: per WHOLE unit (per kg for a product counted in grams), like every other cost.
  if (valued > 0) return Math.round((value * minorPerUnitOf(moves[0]?.uom ?? 'ea')) / valued);
  const costs = await allOf<{ productId: string; cost: Money }>(store, tenantId, streamName(STREAM.inventory, 'production'), 'ProductionCostSet');
  let latestCost: Money | undefined;
  for (const c of costs) if (c.productId === productId) latestCost = c.cost;
  return latestCost?.minor;
}

/**
 * Deliveries booked in on a store screen and relayed through the box (SP-2b · F11): the same GRN register, product
 * master, tolerance policy and atomic commit as the direct route, plus what head office knows that the screen does not —
 * unit cost from its own valuation, ordered quantities from the purchase order, who the receiver really is.
 */
export function syncedGoodsReceiptAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<SyncedGoodsReceiptDeps, 'recordAudit'> {
  return {
    ...goodsReceiptAdapter(input),
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    unitCostMinor: (tenantId, productId) => unitCostHeldFor(input.store, tenantId, productId),
  };
}

/**
 * SP-6b: a delivery's handheld scans assembled into ONE GRN — the relayed receipt's deps (the GRN register, the order, the
 * master, the policy, the cloud's cost, the grants) plus the SP-3a scan register the lines are built from.
 */
export function assembledGoodsReceiptAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<AssembledGoodsReceiptDeps, 'recordAudit'> {
  return { ...syncedGoodsReceiptAdapter(input), scansOf: receivingScanAdapter(input).scansOf };
}

/**
 * The warehouse handheld's put-aways and picks, relayed by the box (SP-3a · F11 handheld half): the same bin registry and
 * append-only movement ledger as the direct route, plus the MOVER's real grants for re-verification.
 */
export function syncedWarehouseAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<SyncedWarehouseDeps, 'recordAudit'> {
  return {
    ...warehouseAdapter(input),
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
  };
}

/**
 * Receiving scans from the warehouse handheld (SP-3a): the M08 ledger's own append (so stock rises at head office when
 * goods come in the back door) plus a GRN-scans register on the purchase stream for SP-6 to assemble the receipt from.
 */
export function receivingScanAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<ReceivingScanDeps, 'recordAudit'> {
  const inv = inventoryAdapter(input);
  const scansStream = streamName(STREAM.purchase, 'grn-scans');
  const scans = (tenantId: string) => allOf<ReceivingScanRecord>(input.store, tenantId, scansStream, 'ReceivingScanRecorded');
  return {
    now: input.now,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    appendMovement: inv.appendMovement,
    isKnown: inv.isKnown,
    scanExists: async (tenantId, commandId) => (await scans(tenantId)).some((r) => r.commandId === commandId),
    scansOf: async (tenantId, grnId) => (await scans(tenantId)).filter((r) => r.grnId === grnId),
    // SP-6b: a scan after the delivery was assembled is said (`after_assembly`) — the GRN register is the one the assembly wrote.
    receiptExists: async (tenantId, grnId) => (await goodsReceiptAdapter(input).grn(tenantId, grnId)) !== undefined,
    // Wave 3 · SF-07 part 3: the goods receipt's own rule (product master + class defaults) and policy, for the scan's cold-chain check.
    productRule: (tenantId, productId) => goodsReceiptAdapter(input).productRule(tenantId, productId),
    receiptPolicy: (tenantId) => goodsReceiptAdapter(input).receiptPolicy(tenantId),
    // OB-31 "A" and M07-FR-02 (round 4 acceptance): the master's unit and the issued order's agreed cost for a phone scan.
    productUom: (tenantId, productId) => productUomFrom(input, tenantId, productId),
    orderUnitCost: (tenantId, poId, productId) => orderUnitCostFrom(input, tenantId, poId, productId),
    recordScan: async (tenantId, scan) => {
      await input.store.append(tenantId, scansStream, makeEvent({
        id: `recv-scan-${scan.commandId}`,
        type: 'ReceivingScanRecorded',
        occurredAt: scan.at,
        // The handheld's own command id: a re-relayed scan collapses to one record (§31.1).
        idempotencyKey: `recv-scan-${tenantId}-${scan.commandId}`,
        source: 'api/inventory',
        payload: scan,
      }));
    },
  };
}


/**
 * Blind counts relayed from a store device (SP-2b · F11 · W2's path): the same count register as the direct route,
 * plus the cloud's own unit value and the tenant's threshold policy — the two figures the direct route still takes from
 * the body (F07), taken here from authoritative records instead.
 */
export function syncedCountsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<SyncedCountsDeps, 'recordAudit'> {
  return {
    ...countsAdapter(input),
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    recordCountPolicy: async (tenantId, policy) => {
      // Hard rule #10 (verifier r18): the value AND the setting it supersedes — re-setting the threshold in force collapses,
      // a change (including back to an earlier value) is a new, latest fact.
      await appendSetting(input.store, tenantId, COUNT_POLICY_STREAM, {
        type: 'CountPolicySet', idPrefix: 'count-policy', valueKey: `count-policy-${tenantId}-${policy.approvalThresholdMinor}`,
        occurredAt: policy.setAt, source: 'api/inventory', payload: policy,
        sameValue: (p) => (p as CountPolicy).approvalThresholdMinor === policy.approvalThresholdMinor,
      });
    },
  };
}

/**
 * Adjustment REQUESTS relayed from the warehouse handheld and decided by a separate person (SP-3b · W3 · M08-FR-03 · §28).
 * Two event types on one stream — the request as recorded, and its decided state — folded latest per request id. The
 * approval's M08 movement goes through the inventory adapter's own append, idempotent on `adj-req:<requestId>`.
 */
const ADJUSTMENT_REQUESTS_STREAM = streamName(STREAM.inventory, 'adjustment-requests');
export function adjustmentRequestAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<AdjustmentRequestDeps, 'recordAudit'> {
  const inv = inventoryAdapter(input);
  const fold = async (tenantId: string): Promise<readonly AdjustmentRequestRecord[]> => {
    const byId = new Map<string, AdjustmentRequestRecord>();
    for (const r of await allOf<AdjustmentRequestRecord>(input.store, tenantId, ADJUSTMENT_REQUESTS_STREAM, 'AdjustmentRequestRecorded')) byId.set(r.requestId, r);
    for (const d of await allOf<AdjustmentRequestRecord>(input.store, tenantId, ADJUSTMENT_REQUESTS_STREAM, 'AdjustmentRequestDecided')) byId.set(d.requestId, d);
    return [...byId.values()];
  };
  return {
    now: input.now,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    unitValueMinor: (tenantId, productId) => unitCostHeldFor(input.store, tenantId, productId),
    request: async (tenantId, requestId) => (await fold(tenantId)).find((r) => r.requestId === requestId),
    requests: (tenantId) => fold(tenantId),
    recordRequest: async (tenantId, record) => {
      await input.store.append(tenantId, ADJUSTMENT_REQUESTS_STREAM, makeEvent({
        id: `adj-req-${record.requestId}`, type: 'AdjustmentRequestRecorded', occurredAt: record.recordedAt,
        // The request's own id: a re-relayed request collapses to one record.
        idempotencyKey: `adj-req-${tenantId}-${record.requestId}`, source: 'api/inventory', payload: record,
      }));
    },
    recordDecision: async (tenantId, record) => {
      await input.store.append(tenantId, ADJUSTMENT_REQUESTS_STREAM, makeEvent({
        id: `adj-req-decided-${record.requestId}`, type: 'AdjustmentRequestDecided', occurredAt: record.decidedAt ?? input.now(),
        // One decision per request: the route refuses a conflicting second one before it gets here.
        idempotencyKey: `adj-req-decided-${tenantId}-${record.requestId}`, source: 'api/inventory', payload: record,
      }));
    },
    appendMovement: inv.appendMovement,
  };
}

/**
 * OB-84 "A" (owner, 12 Oct 2026, "Head office's record decides"): the STORE of an approval's subject, from head office's own
 * register of that subject — a held count, a correction request, a goods receipt's held excess, a day close. undefined when
 * head office does not hold the subject, or cannot place it in a store it knows.
 */
export async function approvalSubjectStore(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, subjectType: string, subjectRef: string): Promise<string | undefined> {
  const r = await storeOfLocationResolver(input, tenantId);
  const placed = (place: string | null | undefined): string | undefined => {
    if (typeof place !== 'string' || place.trim() === '') return undefined;
    const st = r.storeOf(place);
    return r.knownStores.has(st) ? st : undefined;
  };
  switch (subjectType) {
    case 'stock_count': return placed((await allCountReconciliations(input.store, tenantId)).find((c) => c.countId === subjectRef)?.locationId);
    case 'stock_adjustment': { const q = await adjustmentRequestAdapter(input).request(tenantId, subjectRef); return q === undefined ? undefined : placed(q.storeId ?? q.locationId); }
    case 'goods_receipt_excess': return placed((await goodsReceiptAdapter(input).grn(tenantId, subjectRef))?.warehouseId);
    case 'day_close_reopen': case 'day_reopen': return placed((await dayCloseAdapter(input).dayClose(tenantId, subjectRef))?.storeId);
    default: return undefined;
  }
}

/** Every decision record kept, in record order — including one a store relayed for another store's subject (OB-84). */
export async function approvalDecisionRecords(store: EventStore, tenantId: string): Promise<readonly ApprovalDecisionRecord[]> {
  return allOf<ApprovalDecisionRecord>(store, tenantId, APPROVAL_DECISIONS_STREAM, 'ApprovalDecisionRecorded');
}

/**
 * OB-84: the store a decision record came FROM — the store it names, else the one store the store computer that relayed it
 * is granted for (head office's own grants; a decision's body is sealed by the box, so it is never stamped). undefined for
 * a record relayed by a person and naming no store.
 */
export async function decisionStoreResolver(store: EventStore, tenantId: string): Promise<(r: ApprovalDecisionRecord) => string | undefined> {
  const boxStore = new Map<string, string>();
  for (const g of await effectiveGrants(store, tenantId)) {
    if (g.roleId === STORE_COMPUTER_ROLE_ID && g.branchScope !== 'all' && g.branchScope.length === 1) boxStore.set(g.userId, g.branchScope[0]!);
  }
  return (r) => (r.storeId !== null && r.storeId !== '' ? r.storeId : boxStore.get(r.relayedBy));
}

export function approvalDecisionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ApprovalDecisionDeps {
  // Folded latest-per-(request, store) by append order. The route refuses a conflicting second decision (422), so in
  // practice there is one record per request; the fold is what keeps a replayed identical record from doubling.
  // OB-84: a decision another store's computer relayed for a request BEFORE head office held its subject (a pre-claimed id)
  // is kept, never overwritten — but once head office holds the subject, the decision of the subject's OWN store is THE
  // decision for that request; the earlier foreign one is listed as an exception for head office (relay-record-store.ts).
  const fold = async (tenantId: string): Promise<Map<string, ApprovalDecisionRecord>> => {
    const from = await decisionStoreResolver(input.store, tenantId);
    const byKey = new Map<string, ApprovalDecisionRecord>();
    for (const r of await approvalDecisionRecords(input.store, tenantId)) byKey.set(`${r.id}\u0000${from(r) ?? ''}`, r);
    return byKey;
  };
  const plainKey = (tenantId: string, id: string): string => `approval-decision-${tenantId}-${id}`;
  return {
    now: input.now,
    decision: async (tenantId, requestId) => {
      const records = [...(await fold(tenantId)).values()].filter((r) => r.id === requestId);
      if (records.length === 0) return undefined;
      const last = records[records.length - 1]!;
      const subjectStore = await approvalSubjectStore(input, tenantId, last.subjectType, last.subjectRef);
      if (subjectStore === undefined) return last; // head office cannot place the subject: as before
      const from = await decisionStoreResolver(input.store, tenantId);
      const own = records.filter((r) => from(r) === undefined || from(r) === subjectStore);
      return own[own.length - 1];
    },
    decisions: async (tenantId) => [...(await fold(tenantId)).values()],
    recordDecision: async (tenantId, record) => {
      // One decision per request, whichever hop re-sends it (§31.1). OB-84: when the request id is already held by ANOTHER
      // store's record (a pre-claim the route has judged foreign), this store's own decision is kept beside it under its own
      // key — nothing overwritten, nothing merged.
      const held = await input.store.findByIdempotencyKey(tenantId, plainKey(tenantId, record.id));
      const from = await decisionStoreResolver(input.store, tenantId);
      const mine = from(record) ?? 'none';
      const beside = held !== undefined && (from(held.event.payload as ApprovalDecisionRecord) ?? 'none') !== mine;
      await input.store.append(tenantId, APPROVAL_DECISIONS_STREAM, makeEvent({
        id: beside ? `approval-decision-${record.id}-at-${mine}` : `approval-decision-${record.id}`,
        type: 'ApprovalDecisionRecorded',
        occurredAt: record.recordedAt,
        idempotencyKey: beside ? `${plainKey(tenantId, record.id)}-at-${mine}` : plainKey(tenantId, record.id),
        source: 'api/identity',
        payload: record,
      }));
    },
    // The decider's REAL authority, from their grants and the role catalogue — never from the body (§28). No grant
    // at all → undefined (an unknown name), which the route records as its own flag.
    permissionsOfUser: async (tenantId, userId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
      if (roleIds.size === 0) return undefined;
      return [...new Set(ROLE_CATALOGUE.filter((r) => roleIds.has(r.id)).flatMap((r) => r.permissions))];
    },
    // WHERE the decider holds the authority (Wave 2b · PA-03 / PA-01): the branches of the grants that carry it — a
    // manager of br-1 deciding br-2's refund is flagged, not applied. `undefined` when they hold no grant at all.
    branchScopeOfUser: async (tenantId, userId, permission) => {
      const grants = await effectiveGrants(input.store, tenantId);
      if (!grants.some((g) => g.userId === userId)) return undefined;
      return new AccessControl(ROLE_CATALOGUE, grants).branchScopeOf(userId, permission);
    },
  };
}

export function emergencyAccessAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): EmergencyAccessDeps {
  // Folded latest-per-grantId by append order — a revocation (a re-record with revokedAt) supersedes.
  const foldGrants = async (tenantId: string): Promise<readonly EmergencyGrant[]> => {
    const all = await allOf<EmergencyGrant>(input.store, tenantId, EMERGENCY_ACCESS_STREAM, 'EmergencyAccessRecorded');
    const byId = new Map<string, EmergencyGrant>();
    for (const g of all) byId.set(g.grantId, g);
    return [...byId.values()];
  };
  return {
    now: input.now,
    // PA-12 round 10: what the user holds now, so an emergency grant never mixes a machine-only role with a person's.
    rolesHeldBy: (tenantId, userId) => rolesHeldNow(input.store, tenantId, userId, input.now()),
    // OB-95: the catalogue, so an emergency grant never puts the IT/platform role beside a business role.
    roles: () => ROLE_CATALOGUE,
    isPerson: (tenantId, userId) => isPersonNow(input.store, tenantId, userId),
    outsideLoginOf: (tenantId, userId) => outsideLoginOf(input.store, tenantId, userId, input.now()),
    grants: (tenantId) => foldGrants(tenantId),
    grant: async (tenantId, grantId) => (await foldGrants(tenantId)).find((g) => g.grantId === grantId),
    recordGrant: async (tenantId, grantId, grant, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, EMERGENCY_ACCESS_STREAM, makeEvent({
        id: `emergency-access-${grantId}-${d}`,
        type: 'EmergencyAccessRecorded',
        occurredAt: input.now(),
        idempotencyKey: `emergency-access-${tenantId}-${grantId}-${d}`,
        source: 'api/identity',
        payload: grant as unknown as Record<string, unknown>,
      }));
    },
  };
}

export function assortmentAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): AssortmentDeps {
  return {
    now: input.now,
    // Every range entry for the store — append-only; the Assortment resolves the in-force status per date.
    entries: (tenantId, storeId) => allOf<AssortmentEntry>(input.store, tenantId, forAssortment(storeId), 'AssortmentEntryRecorded'),
    // FUL-11: head office's on-hand at the store and every place under it (the org hierarchy says which), from the stock position.
    storeOnHand: async (tenantId, storeId, productId) => {
      const branchOf = branchOfLocationIn(await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId));
      const rows = await inventoryAdapter(input).availability(tenantId, productId);
      return rows.filter((r) => r.locationId === storeId || branchOf(r.locationId) === storeId).reduce((s, r) => s + r.onHandMinor, 0);
    },
    recordEntry: async (tenantId, storeId, entry, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, forAssortment(storeId), makeEvent({
        id: `assortment-${storeId}-${entry.productId}-${d}`,
        type: 'AssortmentEntryRecorded',
        occurredAt: input.now(),
        // A re-sent identical decision collapses; a genuinely new effective-dated change is a new key.
        idempotencyKey: `assortment-${tenantId}-${storeId}-${entry.productId}-${d}`,
        source: 'api/inventory',
        payload: entry,
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

    recordInvoice: async (tenantId, customerId, invoice, openingLoadId) => {
      const at = input.now();
      await input.store.appendBatch(tenantId, [{ stream: forB2BCustomer(customerId), event: makeEvent({
        id: `b2b-inv-${customerId}-${invoice.invoiceId}`,
        type: 'B2BInvoiceRecorded',
        occurredAt: at,
        idempotencyKey: `b2b-inv-${tenantId}-${customerId}-${invoice.invoiceId}-${invoice.grossMinor}-${invoice.dueOn}-${invoice.disputed ?? false}`,
        source: 'api/finance',
        payload: invoice,
      }) }, ...(openingLoadId === undefined ? [] : [openingItemEntry(tenantId, { loadId: openingLoadId, domain: 'receivable', customerId, invoiceId: invoice.invoiceId, openedMinor: invoice.grossMinor }, at)])]);
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

/**
 * FUL-09: a B2B tax invoice's and a collection's money effects, each in ONE atomic write — the receivable collections ages
 * (due on the customer's terms) or the allocation, the AR-ledger movement the credit check reads, and the postable fact the
 * books read (`b2bPostingAdapter`). Keys are the existing ones per record, so a re-issued / re-sent fact collapses.
 */
const B2B_POSTABLES = streamName(STREAM.finance, 'b2b-postables');
export function b2bMoneyEffectsAdapter(input: { readonly store: EventStore; readonly now: () => string }): {
  afterTaxInvoice: (tenantId: string, customerId: string, doc: StoredB2BDocument) => Promise<{ readonly dueOn: string }>;
  recordPaymentWithMoney: (tenantId: string, customerId: string, payment: RecordedPayment, receivedOn: string) => Promise<void>;
} {
  const credit = b2bCreditAdapter(input);
  return {
    afterTaxInvoice: async (tenantId, customerId, doc) => {
      const issuedOn = doc.issuedAt.slice(0, 10);
      const terms = (await credit.account(tenantId, customerId))?.paymentTermsDays ?? 0;
      const dueOn = new Date(Date.parse(`${issuedOn}T00:00:00.000Z`) + terms * 86_400_000).toISOString().slice(0, 10);
      const invoice: CollectionsReceivable = { invoiceId: doc.documentId, number: doc.number, customerId, tenantId, issuedOn, dueOn, grossMinor: doc.grossMinor, settledMinor: 0 };
      const ar: RecordedReceivable = { movementId: `inv-${doc.documentId}`, customerId, kind: 'invoice', deltaMinor: doc.grossMinor, at: doc.issuedAt, ref: doc.number };
      const postable: B2BPostable = { sourceId: `invoice:${customerId}:${doc.documentId}`, kind: 'invoice', customerId, documentDate: issuedOn, components: { total: doc.grossMinor, net: doc.netMinor, tax: doc.taxMinor }, ref: doc.number };
      await input.store.appendBatch(tenantId, [
        { stream: forB2BCustomer(customerId), event: makeEvent({ id: `b2b-inv-${customerId}-${invoice.invoiceId}`, type: 'B2BInvoiceRecorded', occurredAt: doc.issuedAt, idempotencyKey: `b2b-inv-${tenantId}-${customerId}-${invoice.invoiceId}-${invoice.grossMinor}-${invoice.dueOn}-false`, source: 'api/finance', payload: invoice }) },
        { stream: forB2BCustomer(customerId), event: makeEvent({ id: `b2b-ar-${ar.movementId}`, type: 'B2BReceivableMovement', occurredAt: ar.at, idempotencyKey: `b2b-ar-${tenantId}-${ar.movementId}`, source: 'api/finance', payload: ar }) },
        { stream: B2B_POSTABLES, event: makeEvent({ id: `b2b-postable-${postable.sourceId}`, type: 'B2BPostable', occurredAt: doc.issuedAt, idempotencyKey: `b2b-postable-${tenantId}-${postable.sourceId}`, source: 'api/finance', payload: postable }) },
      ]);
      return { dueOn };
    },
    recordPaymentWithMoney: async (tenantId, customerId, payment, receivedOn) => {
      const at = input.now();
      const ar: RecordedReceivable = { movementId: `rcpt-${payment.receiptId}`, customerId, kind: 'payment', deltaMinor: -payment.receivedMinor, at, ref: payment.receiptId };
      const postable: B2BPostable = { sourceId: `receipt:${customerId}:${payment.receiptId}`, kind: 'receipt', customerId, documentDate: receivedOn, components: { amount: payment.receivedMinor }, ref: payment.receiptId };
      await input.store.appendBatch(tenantId, [
        { stream: forB2BCustomer(customerId), event: makeEvent({ id: `b2b-pay-${customerId}-${payment.receiptId}`, type: 'B2BPaymentAllocated', occurredAt: at, idempotencyKey: `b2b-pay-${tenantId}-${customerId}-${payment.receiptId}`, source: 'api/finance', payload: payment }) },
        { stream: forB2BCustomer(customerId), event: makeEvent({ id: `b2b-ar-${ar.movementId}`, type: 'B2BReceivableMovement', occurredAt: at, idempotencyKey: `b2b-ar-${tenantId}-${ar.movementId}`, source: 'api/finance', payload: ar }) },
        { stream: B2B_POSTABLES, event: makeEvent({ id: `b2b-postable-${postable.sourceId}`, type: 'B2BPostable', occurredAt: at, idempotencyKey: `b2b-postable-${tenantId}-${postable.sourceId}`, source: 'api/finance', payload: postable }) },
      ]);
    },
  };
}

export function b2bPostingAdapter(input: { readonly store: EventStore; readonly now: () => string }): B2BPostingDeps {
  const fin = financeAdapter(input);
  return {
    periodStates: fin.periodStates, nextOpenPeriod: fin.nextOpenPeriod, appendJournal: fin.appendJournal, now: input.now,
    postingMap: (tenantId) => latest<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined'),
    postables: (tenantId) => allOf<B2BPostable>(input.store, tenantId, B2B_POSTABLES, 'B2BPostable'),
    b2bJournals: async (tenantId) =>
      (await allOf<JournalEntry | B2BJournal>(input.store, tenantId, STREAM.finance, 'JournalPosted')).filter((j): j is B2BJournal => 'b2b' in j),
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

/** The system actor the till-shortage rule opens a case as (M15-FR-04) — a rule, never a person (P-05). */
const SHORTAGE_RULE_ACTOR = 'system:till-shortage-rule';

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
        // OB-235: a shortage case recorded before the mark existed was opened by the same rule (its system actor says
        // so) — it reads "opened by rule" too. Nothing stored is rewritten (hard rule #2).
        byId.set(c.caseId, c.openedByRule !== true && c.openedBy === SHORTAGE_RULE_ACTOR ? { ...c, openedByRule: true } : c);
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
      const limits = (r: LpRule): string => `${r.maxCount ?? ''}-${r.maxTotalValueMinor ?? ''}-${r.maxSingleValueMinor ?? ''}-${r.escalateAtMultiple ?? ''}`;
      // Keyed on the kind, the limits AND the rule it supersedes (hard rule #10, verifier r18): re-setting the limits in force
      // collapses; a re-tune — including back to earlier limits — is a new, latest fact.
      await appendSetting(input.store, tenantId, rulesStream, {
        type: 'LpRuleSet', idPrefix: `lp-rule-${rule.kind}`, valueKey: `lp-rule-${tenantId}-${rule.kind}-${limits(rule)}`,
        occurredAt: input.now(), source: 'api/pos', payload: rule,
        sameSubject: (p) => (p as LpRule).kind === rule.kind,
        subjectKey: rule.kind,
        sameValue: (p) => limits(p as LpRule) === limits(rule),
      });
    },
  };
}

/**
 * The till's own loss-prevention record (audit PF-07): voids relayed by the store box on their own append-only stream,
 * refunds read from the banked returns projection, the raised exceptions folded latest per id. Rules and cases reuse the
 * adapters above, so there is one fold path per register.
 */
export function lpActivityAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /**
   * The shop's calendar (time zone + trading-day cut-off) from store setup, so a day is judged by the SHOP's trading day
   * — a void at 00:30 belongs to the day still trading (PF-07). Absent = the UTC calendar date.
   */
  readonly calendar?: (tenantId: string) => Promise<TradingCalendar>;
}): LpActivityDeps {
  const activityStream = streamName(STREAM.lossPrevention, 'activity');
  const raisedStream = streamName(STREAM.lossPrevention, 'raised');
  const tradingDayOf = async (tenantId: string, atIso: string): Promise<string> => {
    if (input.calendar === undefined) return atIso.slice(0, 10);
    try { return tradingDayIn(atIso, await input.calendar(tenantId)); } catch { return atIso.slice(0, 10); }
  };
  const dayRange = async (tenantId: string, day: string): Promise<{ from: string; to: string }> => {
    if (input.calendar !== undefined) {
      try {
        const w = tradingDayWindow(day, await input.calendar(tenantId));
        // [from, to) as an inclusive read window.
        return { from: w.from, to: new Date(Date.parse(w.to) - 1).toISOString() };
      } catch { /* an unreadable calendar falls back to the UTC date — said by the route's day */ }
    }
    return { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` };
  };
  const rules = lpRulesAdapter(input);
  const cases = lpCasesAdapter(input);
  return {
    now: input.now,
    activity: async (tenantId, activityId) => (await allOf<TillActivity>(input.store, tenantId, activityStream, 'TillActivityRecorded')).find((a) => a.activityId === activityId),
    recordActivity: async (tenantId, a) => {
      await input.store.append(tenantId, activityStream, makeEvent({
        id: `till-activity-${a.activityId}`, type: 'TillActivityRecorded', occurredAt: a.at,
        idempotencyKey: `till-activity-${tenantId}-${a.activityId}`, source: 'api/pos', payload: a,
      }));
    },
    // Voids, no-sales and price overrides of one trading day: the day the box dated it by, else the shop's calendar.
    heldOn: async (tenantId, day) => {
      const out: TillActivity[] = [];
      for (const a of await allOf<TillActivity>(input.store, tenantId, activityStream, 'TillActivityRecorded')) {
        if ((a.tradingDay ?? await tradingDayOf(tenantId, a.at)) === day) out.push(a);
      }
      return out;
    },
    tradingDayOf,
    // §28: the override authority from head office's OWN grants (owner + store manager), never the relay's word.
    mayApproveOverride: async (tenantId, userId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
      return ROLE_CATALOGUE.some((r) => roleIds.has(r.id) && r.permissions.includes('pos.override.approve'));
    },
    refundsOn: async (tenantId, day) => {
      const { from, to } = await dayRange(tenantId, day);
      const returns = await input.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from, to });
      return returns.map((e) => payloadOf<{ readonly returnId: string; readonly processedBy: string; readonly processedAt: string; readonly refundMinor: number }>(e))
        .map((r) => ({ txnId: r.returnId, kind: 'refund' as const, cashierId: r.processedBy, at: r.processedAt, valueMinor: r.refundMinor }));
    },
    rules: rules.rules,
    raised: async (tenantId) => {
      const byId = new Map<string, RaisedException>();
      for (const r of await allOf<RaisedException>(input.store, tenantId, raisedStream, 'LpExceptionRaised')) byId.set(r.exceptionId, r);
      return [...byId.values()];
    },
    recordRaised: async (tenantId, r) => {
      await input.store.append(tenantId, raisedStream, makeEvent({
        id: `lp-raised-${r.exceptionId}-${r.observed}-${r.severity}`, type: 'LpExceptionRaised', occurredAt: r.raisedAt,
        // A grown or escalated breach is a new fact; the same one again collapses.
        idempotencyKey: `lp-raised-${tenantId}-${r.exceptionId}-${r.observed}-${r.severity}`, source: 'api/pos', payload: r,
      }));
    },
    cases: cases.cases,
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
      // Keyed on the values AND the thresholds they supersede (hard rule #10, verifier r18): re-setting the thresholds in
      // force collapses; a re-tune — including back to earlier values — is a new, latest fact.
      await appendSetting(input.store, tenantId, thresholdsStream, {
        type: 'FraudThresholdsSet', idPrefix: 'fraud-thresholds', valueKey: `fraud-thresholds-${tenantId}-${JSON.stringify(thresholds)}`,
        occurredAt: input.now(), source: 'api/pos', payload: thresholds,
        sameValue: (p) => JSON.stringify(p) === JSON.stringify(thresholds),
      });
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

/** The transfer aggregates' stream — shared by the transfer routes, the inventory reads and the floor indents (SP-8). */
const TRANSFERS_STREAM = streamName(STREAM.warehouse, 'transfers');

/** SP-5 (F05): the M08 postings as batch entries, each idempotent on the inventory adapter's own key format so `isKnown`
 *  and every fold see them as any other movement. */
function movementEntries(tenantId: string, posted: readonly Movement[]): Parameters<EventStore['appendBatch']>[1] {
  return posted.map((m) => ({
    stream: STREAM.inventory,
    event: makeEvent({
      id: `mv-${m.movementId}`,
      type: 'InventoryMoved',
      occurredAt: m.occurredAt,
      idempotencyKey: `mv-${tenantId}-${m.movementId}`,
      source: 'api/inventory',
      payload: m,
    }),
  }));
}
function transferProposedEvent(tenantId: string, transfer: Transfer, at: string): DomainEvent {
  return makeEvent({ id: `transfer-proposed-${transfer.transferId}`, type: 'TransferProposed', occurredAt: at, idempotencyKey: `transfer-proposed-${tenantId}-${transfer.transferId}`, source: 'api/inventory', payload: { transfer } });
}
function transferDispatchedEvent(tenantId: string, transfer: Transfer, movements: readonly StockMovement[], posted: readonly Movement[], at: string): DomainEvent {
  return makeEvent({ id: `transfer-dispatched-${transfer.transferId}`, type: 'TransferDispatched', occurredAt: transfer.dispatchedAt ?? at, idempotencyKey: `transfer-dispatched-${tenantId}-${transfer.transferId}`, source: 'api/inventory', payload: { transfer, movements, posted: posted.map((m) => m.movementId) } });
}
function transferReceivedEvent(tenantId: string, transfer: Transfer, movements: readonly StockMovement[], discrepancies: unknown, posted: readonly Movement[], at: string): DomainEvent {
  return makeEvent({ id: `transfer-received-${transfer.transferId}`, type: 'TransferReceived', occurredAt: transfer.receivedAt ?? at, idempotencyKey: `transfer-received-${tenantId}-${transfer.transferId}`, source: 'api/inventory', payload: { transfer, movements, discrepancies, posted: posted.map((m) => m.movementId) } });
}

export function transfersAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): TransfersDeps {
  // Each transfer folds one per-tenant stream by transferId; the aggregate carried on each event is the
  // latest truth (proposed → in_transit → received). Movements/discrepancies ride the event as evidence.
  const transfersStream = TRANSFERS_STREAM;
  const foldTransfers = async (tenantId: string): Promise<Map<string, Transfer>> => {
    const events = await input.store.readStream(tenantId, transfersStream);
    const byId = new Map<string, Transfer>();
    for (const e of events) {
      const t = (e.event.payload as { transfer?: Transfer }).transfer;
      if (t !== undefined) byId.set(t.transferId, t);
    }
    return byId;
  };

  const inv = inventoryAdapter({ store: input.store, now: input.now });
  const recalls = recallAdapter({ store: input.store, now: input.now });
  const holds = qualityHoldAdapter({ store: input.store, now: input.now });

  /** SP-5 (F05): the transfer event plus its M08 postings, ONE atomic write; every entry idempotent on its own key. */
  const transferBatch = (tenantId: string, event: DomainEvent, posted: readonly Movement[]): Parameters<EventStore['appendBatch']>[1] => [
    { stream: transfersStream, event },
    ...movementEntries(tenantId, posted),
  ];

  return {
    now: input.now,

    transfer: async (tenantId, transferId) => (await foldTransfers(tenantId)).get(transferId),
    // Round 12 (WF-07 screen): every transfer's latest state, in the order first recorded.
    transfers: async (tenantId) => [...(await foldTransfers(tenantId)).values()],

    // SP-5 (F05): the sending location's own weighted-average unit cost for the product — `not_known` (unvalued) → undefined.
    unitCostAt: async (tenantId, locationId, productId) => {
      const here = (await inv.valuation(tenantId, productId)).find((r) => r.locationId === locationId);
      return here === undefined || here.unitCostMinor === 'not_known' ? undefined : here.unitCostMinor;
    },

    // SP-5 · verifier r18 C2-R1: once the business has registered its places (`knownStockPlace`), a place it REGISTERED —
    // never "a location that has ever held stock", which let one stray movement at an unregistered id make that id a
    // transfer destination. A tenant that has registered no place at all keeps the older reading (a bin's store or location,
    // or a place that has held stock): there is nothing registered to judge against, and no store a pack could be built for.
    knownLocation: async (tenantId, locationId) => {
      const known = await knownStockPlace(input, tenantId);
      if (known.registeredAny) return known(locationId);
      if ((await warehouseAdapter(input).bins(tenantId)).some((b) => b.storeId === locationId || b.locationId === locationId)) return true;
      return (await inv.availability(tenantId)).some((r) => r.locationId === locationId);
    },

    // SP-4 (F07): what head office itself holds at the source for each line — the M08 on-hand for the product there,
    // the line's batch marked recalled from the recall register or quarantined from the quality-hold register. The
    // engine then refuses an over-draw and never sends a problem to another branch. Never the body's word.
    //
    // SF-03: ONE batch-, state- and reservation-aware figure. A named batch is measured against THAT batch's on-hand at the
    // source (never the product's total across every batch — the audit sent 50 of batch A when A held 10); a batch the
    // source never held is 0; an expired batch, a batch on quality hold and a recalled batch are refused by state; and
    // what the source has promised to customers is not free to send — the product's free stock (on-hand less the holds
    // that still stand) is shared out across the transfer's lines in order, so two batches cannot both spend it.
    availableAt: async (tenantId, fromLocationId, lines) => {
      const registry = await recalls.registry(tenantId);
      const today = input.now().slice(0, 10);
      const batches = (await inv.batches!(tenantId)).filter((b) => b.locationId === fromLocationId);
      const reserved = new Map<string, number>();
      for (const r of await outstandingReservationsAt(input.store, tenantId, fromLocationId, input.now())) {
        reserved.set(r.productId, (reserved.get(r.productId) ?? 0) + r.quantityMinor);
      }
      const freeOf = new Map<string, number>();
      for (const b of batches) freeOf.set(b.productId, (freeOf.get(b.productId) ?? 0) + b.onHandMinor);
      for (const [productId, n] of reserved) freeOf.set(productId, (freeOf.get(productId) ?? 0) - n);
      const lots: AvailableLot[] = [];
      const seen = new Set<string>();
      for (const line of lines) {
        const key = `${line.productId}\u001f${line.batchId ?? ''}`;
        if (seen.has(key)) continue; // one lot per product and batch; the engine adds up every line that draws on it
        seen.add(key);
        const batch = batches.find((b) => b.productId === line.productId && b.batchId === line.batchId);
        const onHand = Math.max(0, batch?.onHandMinor ?? 0);
        const free = Math.max(0, freeOf.get(line.productId) ?? 0);
        const quantityMinor = Math.min(onHand, free);
        const asked = lines.filter((l) => l.productId === line.productId && l.batchId === line.batchId).reduce((n, l) => n + l.quantityMinor, 0);
        freeOf.set(line.productId, free - Math.min(quantityMinor, asked));
        const hold = line.batchId === null ? undefined : await holds.hold(tenantId, line.batchId);
        const quarantined = hold !== undefined && hold.status !== 'passed' && hold.status !== 'released';
        const isExpired = batch?.expiry !== undefined && batch.expiry < today;
        const recalled = line.batchId !== null && registry.isRecalled(line.batchId);
        lots.push({
          productId: line.productId, batchId: line.batchId, quantityMinor,
          state: quarantined ? 'quarantine' : isExpired ? 'expired' : 'on_hand',
          ...(recalled ? { recalled: true } : {}),
        });
      }
      return lots;
    },

    // SF-03: the unit the published product master counts the product in.
    productUom: async (tenantId, productId) => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return pack?.snapshot.products.find((p) => p.productId === productId)?.baseUom;
    },

    recordProposed: async (tenantId, transfer) => {
      await input.store.append(tenantId, transfersStream, transferProposedEvent(tenantId, transfer, input.now()));
    },

    // The source location's stock guard (Wave 2a · SF-04): one version per location, read before the stock and bumped by
    // every dispatch that leaves it.
    stockVersion: (tenantId, locationId) => input.store.guardVersion(tenantId, stockGuardKey(locationId)),

    // SP-5 (F05): the dispatched aggregate and its `transferred_out` movements at the source commit together, or not at all —
    // under the source's stock guard when the route read one (Wave 2a · SF-04).
    recordDispatched: async (tenantId, transfer, movements, posted, expectedVersion) => {
      await input.store.appendBatch(
        tenantId,
        transferBatch(tenantId, transferDispatchedEvent(tenantId, transfer, movements, posted, input.now()), posted),
        expectedVersion === undefined ? undefined : { guard: { key: stockGuardKey(transfer.fromLocationId), expectedVersion } },
      );
    },

    // SP-5 (F05): the received aggregate and its `transferred_in` movements at the destination, atomically.
    recordReceived: async (tenantId, transfer, movements, discrepancies, posted) => {
      await input.store.appendBatch(tenantId, transferBatch(tenantId, transferReceivedEvent(tenantId, transfer, movements, discrepancies, posted, input.now()), posted));
    },

    // Batch 2: the valued shortfall the transfer's own receipt record raised.
    shortfallOf: async (tenantId, transferId) => {
      for (const e of await input.store.readStream(tenantId, transfersStream, { type: 'TransferReceived' })) {
        const p = payloadOf<{ transfer: Transfer; discrepancies?: readonly TransferDiscrepancy[] }>(e);
        if (p.transfer.transferId === transferId) return shortfallLinesOf(p.discrepancies ?? []);
      }
      return [];
    },
    // Batch 2: a transfer some floor indent's issue travels on — resolved on the indent, never twice.
    belongsToIndent: async (tenantId, transferId) => {
      for (const e of await input.store.readStream(tenantId, streamName(STREAM.warehouse, 'indents'))) {
        if ((e.event.payload as { indent?: FloorIndent }).indent?.issues.some((i) => i.transferId === transferId) === true) return true;
      }
      return false;
    },
    transferVersion: (tenantId, transferId) => input.store.guardVersion(tenantId, transferGuardKey(transferId)),
    // Batch 2: the resolved transfer and the found units' `adjusted` movements, one atomic batch under the transfer's guard.
    recordShortfallResolved: async (tenantId, transfer, posted, expectedVersion) => {
      const at = input.now();
      const digest = createHash('sha256').update(JSON.stringify(transfer.shortfallResolution ?? null)).digest('hex').slice(0, 16);
      await input.store.appendBatch(tenantId, [
        {
          stream: transfersStream,
          event: makeEvent({
            id: `transfer-shortfall-resolved-${transfer.transferId}`, type: 'TransferShortfallResolved', occurredAt: at,
            idempotencyKey: `transfer-shortfall-resolved-${tenantId}-${transfer.transferId}-${digest}`, source: 'api/inventory',
            // Batch 2: `loss` is the shape finance posts the inventory-loss journal from (Batch 3).
            payload: { transfer, ...(transfer.shortfallResolution === undefined ? {} : { loss: shortfallLossOf({ source: 'transfer', transfer, resolution: transfer.shortfallResolution }) }) },
          }),
        },
        ...movementEntries(tenantId, posted),
      ], expectedVersion === undefined ? undefined : { guard: { key: transferGuardKey(transfer.transferId), expectedVersion } });
    },
  };
}

/**
 * The FLOOR INDENT chain (SP-8 · F08 · WF-06/07 · M09-FR-03 · M08-FR-02 · §28). One per-tenant stream, the aggregate
 * carried whole on every event (latest wins, like the transfers). An issue, a floor receipt and an accepted return each
 * commit the indent step, the transfer step(s) it rides on and the M08 movements in ONE atomic batch — the same event
 * shapes and keys the transfer routes write, so the transfer reads, the availability read (`inTransit`), the valuation
 * and the exceptions read (`transferShortfalls`) all see them as any other transfer. Nothing here is a second stock
 * posting: the indent aggregate moves no stock; its transfers do, once.
 */
export function floorIndentsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<SyncedFloorIndentsDeps, 'recordAudit'> {
  const indentsStream = streamName(STREAM.warehouse, 'indents');
  const transfers = transfersAdapter(input);
  const inv = inventoryAdapter(input);
  // SP-8c: head office's bin register and the stream its bin movements collapse on — a handheld issue lowers its bin in the same write.
  const wh = warehouseAdapter({ store: input.store, now: input.now });
  const warehouseMovementsStream = streamName(STREAM.warehouse, 'movements');

  const foldIndents = async (tenantId: string): Promise<Map<string, FloorIndent>> => {
    const events = await input.store.readStream(tenantId, indentsStream);
    const byId = new Map<string, FloorIndent>();
    for (const e of events) {
      const i = (e.event.payload as { indent?: FloorIndent }).indent;
      if (i !== undefined) byId.set(i.indentId, i);
    }
    return byId;
  };
  const stepEvent = (tenantId: string, type: string, indent: FloorIndent, step: string, sub: string | null, at: string): { stream: string; event: DomainEvent } => ({
    stream: indentsStream,
    event: makeEvent({
      id: `indent-${step}-${indent.indentId}${sub === null ? '' : `-${sub}`}`,
      type,
      occurredAt: at,
      idempotencyKey: `indent-${step}-${tenantId}-${indent.indentId}${sub === null ? '' : `-${sub}`}`,
      source: 'api/inventory',
      payload: { indent },
    }),
  });

  /** Batch 2: a guarded step's key suffix — the version it was decided on and a digest of the aggregate it records. */
  const guardedSub = (sub: string, indent: FloorIndent, expectedVersion: number | undefined): string =>
    expectedVersion === undefined ? sub : `${sub}-v${expectedVersion}-${createHash('sha256').update(JSON.stringify(indent)).digest('hex').slice(0, 16)}`;

  return {
    now: input.now,
    indent: async (tenantId, indentId) => (await foldIndents(tenantId)).get(indentId),
    indents: async (tenantId) => [...(await foldIndents(tenantId)).values()],
    transferOf: async (tenantId, transferId) => (await foldTransferAggregates(input.store, tenantId)).find((t) => t.transferId === transferId),
    // SP-8b: the requester / receiver a relayed step names, re-verified from THEIR grants (record-and-flag).
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    // SP-8c: head office's bin register, so a handheld issue lowers the bin it took from in the same write.
    bins: (tenantId) => wh.bins(tenantId),
    contents: (tenantId) => wh.contents(tenantId),
    appliedCommandIds: (tenantId) => wh.appliedCommandIds(tenantId),
    knownLocation: transfers.knownLocation,
    availableAt: transfers.availableAt,
    unitCostAt: transfers.unitCostAt,
    // Head office's own on-hand at the back store per product — the allocation is judged against this, never the ask.
    onHandAt: async (tenantId, locationId, productIds) => {
      const out: { productId: string; onHandMinor: number }[] = [];
      for (const productId of productIds) {
        const rows = await inv.availability(tenantId, productId);
        out.push({ productId, onHandMinor: rows.filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0) });
      }
      return out;
    },
    recordIndent: async (tenantId, indent, type) => {
      const step = type === 'FloorIndentRequested' ? 'requested' : type === 'FloorIndentApproved' ? 'approved' : type === 'FloorIndentRejected' ? 'rejected' : type === 'FloorIndentCancelled' ? 'cancelled' : 'return-requested';
      const sub = type === 'FloorIndentReturnRequested' ? (indent.returns.at(-1)?.returnId ?? null) : null;
      const at = input.now();
      await input.store.append(tenantId, indentsStream, stepEvent(tenantId, type, indent, step, sub, at).event);
    },
    // An ISSUE: the indent step, the transfer proposed + dispatched, and the `transferred_out` movements — one atomic batch.
    // Batch 2 · the write guards on the chain: the back store's stock guard (the SAME key a transfer dispatch takes, SF-04)
    // and the indent's own.
    stockVersion: (tenantId, locationId) => input.store.guardVersion(tenantId, stockGuardKey(locationId)),
    indentVersion: (tenantId, indentId) => input.store.guardVersion(tenantId, indentGuardKey(indentId)),
    recordIssued: async (tenantId, indent, transfer, movements, posted, binMovements = [], expectedStockVersion) => {
      const at = input.now();
      const issue = indent.issues.find((i) => i.transferId === transfer.transferId);
      await input.store.appendBatch(tenantId, [
        // A guarded step's key carries a digest of what it records (Batch 2): two DIFFERENT writes racing under one issue id
        // cannot both dedupe into a silent "success" — the loser stages its own step, meets the moved guard and is refused by
        // name. (An exact replay never reaches here: the route answers "already issued" from the record first.)
        stepEvent(tenantId, 'FloorIndentIssued', indent, 'issued', guardedSub(issue?.issueId ?? transfer.transferId, indent, expectedStockVersion), at),
        { stream: TRANSFERS_STREAM, event: transferProposedEvent(tenantId, { ...transfer, state: 'proposed', approvedBy: undefined, dispatchedAt: undefined, lineCostsMinor: undefined }, at) },
        { stream: TRANSFERS_STREAM, event: transferDispatchedEvent(tenantId, transfer, movements, posted, at) },
        ...movementEntries(tenantId, posted),
        // SP-8c: the back-store BIN the handheld took from, lowered in the SAME write — the same `WarehouseMovementRecorded`
        // the handheld's own put-aways and picks collapse on, keyed on the command, so a re-sent issue moves a bin once.
        ...binMovements.map((m) => ({
          stream: warehouseMovementsStream,
          event: makeEvent({ id: `wh-move-${m.commandId}`, type: 'WarehouseMovementRecorded', occurredAt: at, idempotencyKey: `wh-move-${tenantId}-${m.commandId}`, source: 'api/inventory', payload: { commandId: m.commandId, movements: m.movements } }),
        })),
      ], expectedStockVersion === undefined ? undefined : { guard: { key: stockGuardKey(transfer.fromLocationId), expectedVersion: expectedStockVersion } });
    },
    // A floor RECEIPT: the indent step, the received transfer and the `transferred_in` movements — one atomic batch.
    recordReceipt: async (tenantId, indent, transfer, movements, discrepancies, posted, expectedIndentVersion, held, writeOffs) => {
      const at = input.now();
      const issue = indent.issues.find((i) => i.transferId === transfer.transferId);
      await input.store.appendBatch(tenantId, [
        stepEvent(tenantId, 'FloorIndentReceived', indent, 'received', guardedSub(issue?.issueId ?? transfer.transferId, indent, expectedIndentVersion), at),
        // The transfer's own record carries what it brought IN; a damaged write-off (SP-8c) rides the same batch as a movement only.
        { stream: TRANSFERS_STREAM, event: transferReceivedEvent(tenantId, transfer, movements, discrepancies, posted.filter((m) => m.kind === 'transferred_in'), at) },
        ...movementEntries(tenantId, posted),
        // OB-66: a damaged write-off HELD on an open count plan — in the same write as the receipt, never lost.
        ...(held ?? []).map((h) => heldWriteOffEntry(tenantId, h)),
        // OB-71: a damaged write-off with NO count holding it — on the write-off register (M28) in the same write, keyed on its
        // `wasted` posting, so a replayed receipt records it once and the books post it once (stock_write_off).
        ...(writeOffs ?? []).map((w) => writeOffCommittedEntry(tenantId, w)),
      ], expectedIndentVersion === undefined ? undefined : { guard: { key: indentGuardKey(indent.indentId), expectedVersion: expectedIndentVersion } });
    },
    // A RETURN accepted at the back store: the indent step and the return's transfer proposed, dispatched and received in
    // one step — a trolley walk — with the `transferred_out` (floor) and `transferred_in` (back store) movements.
    recordReturnAccepted: async (tenantId, indent, transfer, dispatchMovements, receiveMovements, discrepancies, posted) => {
      const at = input.now();
      const ret = indent.returns.find((r) => r.transferId === transfer.transferId);
      const dispatched: Transfer = { ...transfer, state: 'in_transit', receivedAt: undefined };
      await input.store.appendBatch(tenantId, [
        stepEvent(tenantId, 'FloorIndentReturnAccepted', indent, 'return-accepted', ret?.returnId ?? transfer.transferId, at),
        { stream: TRANSFERS_STREAM, event: transferProposedEvent(tenantId, { ...transfer, state: 'proposed', approvedBy: undefined, dispatchedAt: undefined, receivedAt: undefined, lineCostsMinor: undefined }, at) },
        { stream: TRANSFERS_STREAM, event: transferDispatchedEvent(tenantId, dispatched, dispatchMovements, posted.filter((m) => m.kind === 'transferred_out'), at) },
        { stream: TRANSFERS_STREAM, event: transferReceivedEvent(tenantId, transfer, receiveMovements, discrepancies, posted.filter((m) => m.kind === 'transferred_in'), at) },
        ...movementEntries(tenantId, posted),
      ]);
    },
    // Batch 2: a shortfall RESOLVED — the indent step and the found units' compensating `adjusted` movements, one atomic batch
    // (each idempotent on its own key, so a replay posts nothing twice).
    recordShortfallResolved: async (tenantId, indent, issueId, posted, expectedIndentVersion) => {
      const at = input.now();
      await input.store.appendBatch(tenantId, [
        lossStep(tenantId, stepEvent(tenantId, 'FloorIndentShortfallResolved', indent, 'shortfall-resolved', guardedSub(issueId, indent, expectedIndentVersion), at), indent, issueId, await foldTransferAggregates(input.store, tenantId)),
        ...movementEntries(tenantId, posted),
      ], expectedIndentVersion === undefined ? undefined : { guard: { key: indentGuardKey(indent.indentId), expectedVersion: expectedIndentVersion } });
    },
  };
}

/**
 * Batch 2: a floor-indent shortfall resolution's event carries the `loss` summary finance posts from (Batch 3) beside the
 * indent — the same `ShortfallLoss` shape a plain transfer's resolution carries.
 */
function lossStep(tenantId: string, step: { stream: string; event: DomainEvent }, indent: FloorIndent, issueId: string, transfers: readonly Transfer[]): { stream: string; event: DomainEvent } {
  void tenantId;
  const issue = indent.issues.find((i) => i.issueId === issueId);
  const transfer = issue === undefined ? undefined : transfers.find((t) => t.transferId === issue.transferId);
  if (issue?.shortfallResolution === undefined || transfer === undefined) return step;
  const loss = shortfallLossOf({ source: 'floor_indent', transfer, resolution: issue.shortfallResolution, indentId: indent.indentId, issueId });
  return { ...step, event: { ...step.event, payload: { ...(step.event.payload as Record<string, unknown>), loss } } };
}

/** The transfer aggregates (latest state each) — shared by the transfers adapter and the inventory reads (SP-5). */
async function foldTransferAggregates(store: EventStore, tenantId: string): Promise<readonly Transfer[]> {
  const events = await store.readStream(tenantId, streamName(STREAM.warehouse, 'transfers'));
  const byId = new Map<string, Transfer>();
  for (const e of events) {
    const t = (e.event.payload as { transfer?: Transfer }).transfer;
    if (t !== undefined) byId.set(t.transferId, t);
  }
  return [...byId.values()];
}

/** The tenant's count-approval policy — one per tenant, latest wins, on its own inventory stream (SP-2b). */
const COUNT_POLICY_STREAM = streamName(STREAM.inventory, 'count-policy');

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
  const wh = warehouseAdapter({ store: input.store, now: input.now });

  // Two event types, one register: the reconciliation as recorded, then (SP-4) its decided state, latest per count id.
  const foldReconciliations = async (tenantId: string): Promise<readonly StoredReconciliation[]> => {
    const byId = new Map<string, StoredReconciliation>();
    for (const r of await allOf<StoredReconciliation>(input.store, tenantId, countsStream, 'CountReconciled')) byId.set(r.countId, r);
    for (const d of await allOf<StoredReconciliation>(input.store, tenantId, countsStream, 'CountDecided')) byId.set(d.countId, d);
    return [...byId.values()];
  };

  return {
    now: input.now,

    // SP-4 (F07): the value and the threshold are head office's — never the body's — on every count route.
    unitValueMinor: (tenantId, productId) => unitCostHeldFor(input.store, tenantId, productId),
    countPolicy: (tenantId) => latest<CountPolicy>(input.store, tenantId, COUNT_POLICY_STREAM, 'CountPolicySet'),
    // SP-3b (W2): a BIN-level count from the warehouse handheld is reconciled against head office's own bin contents —
    // the warehouse projection, every batch of the product in that bin. A bin head office never registered is `undefined`.
    binExpected: async (tenantId, binId, productId) => {
      const bins = await wh.bins(tenantId);
      if (!bins.some((b) => b.binId === binId)) return undefined;
      const prefix = binKey(binId, productId, null); // `bin|product|` — every batch of the product in this bin
      return Object.entries(await wh.contents(tenantId)).filter(([k]) => k.startsWith(prefix)).reduce((s, [, q]) => s + q, 0);
    },

    reconciliation: async (tenantId, countId) => (await foldReconciliations(tenantId)).find((r) => r.countId === countId),

    // SP-4: the decided state of a held count — a second event; the fold takes the latest (append-only, #2). SP-5b: an
    // APPROVED correction's M08 movement (and bin movement) commit in the same write.
    recordDecision: async (tenantId, rec) => {
      await input.store.appendBatch(tenantId, countBatch(tenantId, makeEvent({
        id: `count-decided-${rec.countId}`,
        type: 'CountDecided',
        occurredAt: rec.decidedAt ?? input.now(),
        // One decision per count: the route refuses a conflicting second one before it gets here.
        idempotencyKey: `count-decided-${tenantId}-${rec.countId}`,
        source: 'api/inventory',
        payload: rec,
      }), rec));
    },

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

    // SP-5b (F06): the record and — when the count corrected at once — its M08 movement (and bin movement) in ONE write.
    recordReconciliation: async (tenantId, rec) => {
      await input.store.appendBatch(tenantId, countBatch(tenantId, makeEvent({
        id: `count-${rec.countId}`,
        type: 'CountReconciled',
        occurredAt: rec.at,
        // The count's own id — a re-sent reconciliation of the same count collapses rather than
        // layering the correction twice (append-only, #2). A re-count is a NEW count id.
        idempotencyKey: `count-${tenantId}-${rec.countId}`,
        source: 'api/inventory',
        payload: rec,
      }), rec));
    },
  };

  /**
   * The count event plus the correction it posts (SP-5b · F06): the M08 movement in the inventory adapter's own format
   * (`mv-<id>`) so every fold reads it as any other movement, and for a bin count the warehouse movement in ITS format
   * (`wh-move-<commandId>`) so the bin's occupancy corrects — all idempotent on the count's movement id, all one write.
   */
  function countBatch(tenantId: string, event: DomainEvent, rec: StoredReconciliation): Parameters<EventStore['appendBatch']>[1] {
    const correction = countCorrection(rec);
    if (correction === undefined) return [{ stream: countsStream, event }];
    return [
      { stream: countsStream, event },
      {
        stream: STREAM.inventory,
        event: makeEvent({
          id: `mv-${correction.movement.movementId}`, type: 'InventoryMoved', occurredAt: correction.movement.occurredAt,
          idempotencyKey: `mv-${tenantId}-${correction.movement.movementId}`, source: 'api/inventory', payload: correction.movement,
        }),
      },
      ...(correction.bin === undefined ? [] : [{
        stream: streamName(STREAM.warehouse, 'movements'),
        event: makeEvent({
          id: `wh-move-${correction.bin.commandId}`, type: 'WarehouseMovementRecorded', occurredAt: correction.bin.movement.at,
          idempotencyKey: `wh-move-${tenantId}-${correction.bin.commandId}`, source: 'api/inventory',
          payload: { commandId: correction.bin.commandId, movements: [correction.bin.movement] },
        }),
      }]),
    ];
  }
}

export function writeOffAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): WriteOffDeps {
  // Committed write-offs live on their own append-only stream. `recordWriteOff` is idempotent on the
  // write-off id — a re-sent write-off of the same id collapses rather than recording the loss twice
  // (append-only, hard rule #2). A correction is a NEW, compensating write-off with its own id.
  const writeOffStream = streamName(STREAM.inventory, 'write-offs');
  // The tenant's material-loss threshold (M28-FR-01) — tenant-wide config, append-only (latest wins).
  const thresholdStream = streamName(STREAM.inventory, 'write-off-threshold');
  // Reused to emit the compensating stock movement (same append + snapshot path as any movement).
  const inv = inventoryAdapter({ store: input.store, now: input.now });
  const fold = async (tenantId: string): Promise<readonly StoredWriteOff[]> =>
    allOf<StoredWriteOff>(input.store, tenantId, writeOffStream, 'WriteOffCommitted');

  return {
    now: input.now,
    writeOffs: (tenantId) => fold(tenantId),
    writeOffExists: async (tenantId, id) => (await fold(tenantId)).some((r) => r.id === id),
    recordWriteOff: async (tenantId, rec) => {
      // One truth (P-02): a committed loss REDUCES on-hand, not merely records it for finance. Emit the
      // compensating `wasted` movement, keyed on the write-off id so a re-sync is one reduction not two.
      await inv.appendMovement(tenantId, {
        movementId: `writeoff-${rec.id}`,
        productId: rec.productId, locationId: rec.locationId, kind: 'wasted',
        quantityMinor: rec.qtyRemoved, uom: rec.uom, occurredAt: rec.at,
        reason: rec.reasonCode, enteredBy: rec.raisedBy,
        ...(rec.approvedBy !== null ? { approvedBy: rec.approvedBy } : {}),
        // WF-09 (round 8): a batch's write-off takes the stock off THAT batch.
        ...(rec.batchId === undefined ? {} : { batchId: rec.batchId }),
      });
      const entry = writeOffCommittedEntry(tenantId, rec);
      await input.store.append(tenantId, entry.stream, entry.event);
    },
    // SF-05: head office's own average unit cost of the stock at the location — the same read a transfer values by.
    unitCostAt: async (tenantId, locationId, productId) => {
      const here = (await inv.valuation(tenantId, productId)).find((r) => r.locationId === locationId);
      return here === undefined || here.unitCostMinor === 'not_known' ? undefined : here.unitCostMinor;
    },
    writeOffThreshold: async (tenantId) => {
      const all = await allOf<{ thresholdMinor: number }>(input.store, tenantId, thresholdStream, 'WriteOffThresholdSet');
      const last = all[all.length - 1];
      return last === undefined ? undefined : last.thresholdMinor;
    },
    recordWriteOffThreshold: async (tenantId, thresholdMinor, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, thresholdStream, makeEvent({
        id: `write-off-threshold-${d}`,
        type: 'WriteOffThresholdSet',
        occurredAt: input.now(),
        idempotencyKey: `write-off-threshold-${tenantId}-${d}`,
        source: 'api/inventory',
        payload: { thresholdMinor },
      }));
    },
    // Non-own owners currently holding stock of this product at this location (M27-FR-02), folded from
    // the M08 ledger's `ownership` field. Own stock never blocks a store write-off, so it is skipped;
    // a non-own owner with positive on-hand means the shelf holds somebody else's inventory here.
    ownersOfStockAt: async (tenantId, productId, locationId) => {
      const events = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
      const here = events
        .map((e) => payloadOf<Movement>(e))
        .filter((m) => m.productId === productId && m.locationId === locationId);
      const byOwner = new Map<string, { ownership: StockOwnership; ownerId: string; qty: number }>();
      for (const m of here) {
        const ownership: StockOwnership = m.ownership ?? 'own';
        if (ownership === 'own') continue;
        const ownerId = m.ownerId ?? 'unknown';
        const key = `${ownership}\u001f${ownerId}`;
        const acc = byOwner.get(key) ?? { ownership, ownerId, qty: 0 };
        acc.qty += m.quantityMinor * EFFECT_ON_HAND[m.kind];
        byOwner.set(key, acc);
      }
      return [...byOwner.values()].filter((o) => o.qty > 0).map((o) => ({ ownership: o.ownership, ownerId: o.ownerId }));
    },
  };
}

export function productionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /** The tenant's enabled paid features (M36-FR-01) — injected from main so the fold lives in one place
   *  (`tenantEntitlementResolver`). Absent → default-deny: no specialised department can be operated. */
  readonly entitledFeatures?: (tenantId: string) => Promise<readonly string[]> | readonly string[];
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

    // FUL-08: an explicit VERSION per recipe, judged by a digest over the COMPLETE recipe. The same recipe as the current
    // version collapses; any change — even 100 g → 150 g flour with the same number of inputs — is the next version, kept
    // beside the earlier ones. Returning to an older recipe is a new version too (never a silent collapse onto history).
    recordRecipe: async (tenantId, recipe) => {
      const digest = recipeDigest(recipe);
      const history = (await allOf<Recipe & { readonly digest?: string; readonly version?: number }>(input.store, tenantId, productionStream, 'RecipeRegistered'))
        .filter((r) => r.recipeId === recipe.recipeId);
      const current = history.at(-1);
      const currentDigest = current === undefined ? undefined : current.digest ?? recipeDigest(current);
      if (currentDigest === digest) return { version: current?.version ?? history.length, digest, changed: false };
      const version = history.length + 1;
      await input.store.append(tenantId, productionStream, makeEvent({
        id: `recipe-${recipe.recipeId}-v${version}`,
        type: 'RecipeRegistered',
        occurredAt: input.now(),
        idempotencyKey: `recipe-${tenantId}-${recipe.recipeId}-v${version}-${digest}`,
        source: 'api/inventory',
        payload: { ...recipe, digest, version },
      }));
      return { version, digest, changed: true };
    },

    // OB-68 / OB-39: the ingredient's average buying cost at the store the run's location belongs to, as it stands now.
    averageCostAt: async (tenantId, locationId, productId) => {
      const [{ storeOf }, avg] = await Promise.all([storeOfLocationResolver(input, tenantId), averageBuyingCosts(input, tenantId)]);
      return avg.costOf(productId, storeOf(locationId));
    },
    ingredientCost: async (tenantId, productId) => {
      const set = await allOf<{ productId: string; cost: Money }>(input.store, tenantId, productionStream, 'ProductionCostSet');
      let latest: Money | undefined;
      for (const s of set) if (s.productId === productId) latest = s.cost; // last write wins
      return latest;
    },

    recordCost: async (tenantId, productId, cost) => {
      // Keyed on the product, the value AND the cost it supersedes (hard rule #10, verifier r18): re-setting the cost in
      // force collapses; a new value — including back to an earlier one — supersedes (the fixed id used to refuse it).
      await appendSetting(input.store, tenantId, productionStream, {
        type: 'ProductionCostSet', idPrefix: `prod-cost-${productId}`, valueKey: `prod-cost-${tenantId}-${productId}-${cost.minor}-${cost.currency}`,
        occurredAt: input.now(), source: 'api/inventory', payload: { productId, cost },
        sameSubject: (p) => (p as { productId: string }).productId === productId,
        subjectKey: productId,
        sameValue: (p) => { const c = (p as { cost: Money }).cost; return c.minor === cost.minor && c.currency === cost.currency; },
      });
    },

    onHand: async (tenantId, productId, locationId) => {
      const rows = await inv.availability(tenantId, productId);
      const here = rows.find((r) => r.productId === productId && r.locationId === locationId);
      return here?.onHandMinor ?? 0;
    },

    // FUL-01: only runs recorded BEFORE production posted its consumption to M08 — a newer run's flour is already off the ledger.
    priorConsumption: async (tenantId, locationId) => {
      const consumed: Record<string, number> = {};
      for (const run of await foldRuns(tenantId)) {
        if (run.locationId !== locationId || run.ledgerMovementIds !== undefined) continue;
        for (const c of run.consumed) consumed[c.productId] = (consumed[c.productId] ?? 0) + c.quantityMinor;
      }
      return consumed;
    },

    runExists: async (tenantId, runId) =>
      (await allOf<StoredRun>(input.store, tenantId, productionStream, 'ProductionRunCommitted')).some((r) => r.runId === runId),

    runs: (tenantId) => foldRuns(tenantId),

    run: async (tenantId, runId) => (await foldRuns(tenantId)).find((r) => r.runId === runId),

    // FUL-01: the run record and its ingredients' M08 movements commit together, under the location's stock guard.
    recordRun: async (tenantId, run, movements, expectedStockVersion) => {
      await input.store.appendBatch(tenantId, [
        {
          stream: productionStream,
          event: makeEvent({
            id: `prod-run-${run.runId}`,
            type: 'ProductionRunCommitted',
            occurredAt: run.at,
            // The run's own id — a re-sent run collapses rather than consuming the ingredients twice
            // (append-only, #2). A re-make is a NEW run id.
            idempotencyKey: `prod-run-${tenantId}-${run.runId}`,
            source: 'api/inventory',
            payload: run,
          }),
        },
        ...movementEntries(tenantId, movements),
      ], expectedStockVersion === undefined ? undefined : { guard: { key: stockGuardKey(run.locationId), expectedVersion: expectedStockVersion } });
    },

    // FUL-01: the release record and the finished batch's `produced` movement commit together.
    recordRelease: async (tenantId, release, movements) => {
      await input.store.appendBatch(tenantId, [
        {
          stream: productionStream,
          event: makeEvent({
            id: `prod-release-${release.runId}`,
            type: 'ProductionBatchReleased',
            occurredAt: release.releasedAt,
            // The run's own id — a re-sent release collapses (append-only, #2); the batch is released once.
            idempotencyKey: `prod-release-${tenantId}-${release.runId}`,
            source: 'api/inventory',
            payload: release,
          }),
        },
        ...movementEntries(tenantId, movements),
      ]);
    },

    stockVersion: (tenantId, locationId) => input.store.guardVersion(tenantId, stockGuardKey(locationId)),

    enabledDepartments: async (tenantId) => {
      const enabled = await allOf<{ departmentId: string }>(input.store, tenantId, productionStream, 'ProductionDepartmentEnabled');
      return [...new Set(enabled.map((e) => e.departmentId))];
    },

    entitledFeatures: input.entitledFeatures ?? (() => []),

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

/**
 * Weighed-department costing (M11-FR-02). Costed weighed runs live on the SAME append-only production
 * stream as recipe runs, under their own `WeighedRunCosted` type; the board and the idempotency check
 * fold them by id (latest wins, though a run is only costed once). Nothing here moves stock.
 */
export function weighedCostingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): WeighedCostingDeps {
  const productionStream = streamName(STREAM.inventory, 'production');
  const fold = async (tenantId: string): Promise<readonly StoredWeighedRun[]> => {
    const all = await allOf<StoredWeighedRun>(input.store, tenantId, productionStream, 'WeighedRunCosted');
    const byId = new Map<string, StoredWeighedRun>();
    for (const r of all) byId.set(r.runId, r); // last write wins (a run is costed once)
    return [...byId.values()];
  };
  return {
    now: input.now,
    weighedRuns: (tenantId) => fold(tenantId),
    weighedRun: async (tenantId, runId) => (await fold(tenantId)).find((r) => r.runId === runId),
    recordWeighedRun: async (tenantId, run) => {
      await input.store.append(tenantId, productionStream, makeEvent({
        id: `weighed-run-${run.runId}`,
        type: 'WeighedRunCosted',
        occurredAt: run.at,
        // A weighed run is costed once — the same run id collapses rather than doubling.
        idempotencyKey: `weighed-run-${tenantId}-${run.runId}`,
        source: 'api/inventory',
        payload: run,
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

    recordBatch: async (tenantId, batch, provenance) => {
      await input.store.append(tenantId, STREAM.settlement, makeEvent({
        id: `settle-batch-${batch.batchId}`,
        type: 'SettlementBatchImported',
        occurredAt: batch.settlementDate + 'T00:00:00.000Z',
        // The batch's own id, no timestamp — re-importing the same file collapses rather than
        // doubling every credit in it. (The route also refuses a duplicate outright; this is the
        // backstop at the ledger, where the guarantee actually has to hold.)
        idempotencyKey: `settle-batch-${tenantId}-${batch.batchId}`,
        source: 'api/finance',
        // Who brought the file in, and when (PF-12): independent evidence keeps its provenance.
        payload: provenance === undefined ? batch : { ...batch, provenance },
      }));
    },

    // Every imported credit line, flattened. Bounded: a shop imports a handful of batches a day, and
    // a batch is refused before it lands unless its lines sum to what it declares.
    credits: async (tenantId) =>
      (await batches(tenantId)).flatMap((b) => b.lines) satisfies readonly SettlementLine[],

    // Electronic tenders captured in the window, from the day's sales. Cash carries no provider
    // reference and is not part of settlement — only ref-bearing (card/UPI) tenders are projected.
    // The read is windowed at the store on `occurredAt`, so it costs a window, not the whole history.
    //
    // OB-271 · OB-274 · audit A9: a card/UPI tender taken on the shop's OWN machine carries the machine's approval / auth
    // code or RRN (`machineRef`) — the number printed on the machine's settlement slip. The tender's `ref` there is the
    // store computer's own attempt id, a number the machine never saw, so nothing on the slip could ever match it. Such a
    // tender is reviewed BY ITS APPROVAL NUMBER: the slip's line ticks it, and one with no line on the slip stays an
    // unmatched exception (hard rule #10, P-08). Two payments with the same approval number are never silently paired —
    // the matcher reports the number as ambiguous. A tender with no machine number is reviewed by its `ref`, as before.
    electronicTenders: async (tenantId, fromIso, toIso) => {
      const sales = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: fromIso, to: toIso });
      const out: CapturedTender[] = [];
      for (const e of sales) {
        const sale = e.event.payload as IncomingSale;
        const capturedOn = sale.committedAt.slice(0, 10);
        sale.tenders.forEach((t, i) => {
          const key = settlementKeyOf(t);
          if (key !== undefined) out.push({ id: `${sale.saleId}:t${i}`, ref: key, amountMinor: t.amountMinor, capturedOn });
        });
      }
      return out;
    },
  };
}

/**
 * OB-271 · audit A9: the reference a card/UPI tender is reconciled against the provider's settlement file by — the shop's
 * own machine's approval number (`machineRef`, kept only in its checked form: 4–20 capitals or digits, never card data)
 * when the tender carries one, else its provider reference. `undefined` for a tender with neither (cash).
 */
export function settlementKeyOf(t: { readonly ref?: unknown; readonly machineRef?: unknown }): string | undefined {
  if (typeof t.machineRef === 'string') {
    const read = readMachineReference(t.machineRef);
    if (read.ok) return read.value;
  }
  return typeof t.ref === 'string' && t.ref.trim() !== '' ? t.ref : undefined;
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
  /** SF-03 — the same balances per batch. Absent on snapshots taken before SF-03: the batch read then folds from the start. */
  readonly batchBalances?: readonly BatchBalance[];
}

/**
 * NEW-7 (D-5): the ONE way a write-off reaches the register stream. Every path (the write-off route, a held returned unit's
 * decision, a damaged arrival, a held write-off applied at a count's close) builds its entry here, and this refuses a reason
 * that is not on the closed waste reason list (OB-159) before anything is appended. The guardrail
 * tests/guardrails/every-write-off-speaks-the-closed-reason-list.test.ts proves there is no other builder.
 */
export function writeOffCommittedEntry(tenantId: string, w: StoredWriteOff, occurredAt: string = w.at): { readonly stream: string; readonly event: DomainEvent } {
  assertWriteOffReasonOnList(w);
  return {
    stream: streamName(STREAM.inventory, 'write-offs'),
    event: makeEvent({ id: `write-off-${w.id}`, type: 'WriteOffCommitted', occurredAt, idempotencyKey: `write-off-${tenantId}-${w.id}`, source: 'api/inventory', payload: w }),
  };
}

const RECEIPT_POLICY_STREAM = streamName(STREAM.inventory, 'receipt-policy');

/** One inbound movement in the SAME format the inventory adapter uses, so the availability projection folds it as any other (mv-<movementId>). */
const movementEvent = (tenantId: string, m: Movement) => ({
  stream: STREAM.inventory,
  event: makeEvent({
    id: `mv-${m.movementId}`,
    type: 'InventoryMoved',
    occurredAt: m.occurredAt,
    idempotencyKey: `mv-${tenantId}-${m.movementId}`,
    source: 'api/inventory',
    payload: m,
  }),
});

/**
 * The goods-receipt (GRN) store (M07-FR-01/02/03 · D03-FR-02) — the durable cloud record of every delivery
 * received. A GRN is a `GoodsReceived` event on the tenant's GRN stream; its SELLABLE lines are inbound
 * `received` movements on the shared inventory stream (so availability learns about the receipt, M08) — and
 * the two are ONE atomic append (FND-01), so a GRN never lands with its movements missing. Idempotent on the
 * GRN id, so a re-scan / re-sync is one effect (§31.1).
 *
 * SP-4 (ii) / F03: the product's tracking rule is read from the PUBLISHED CATALOGUE (the product master the tills
 * run on) and the tolerances from the tenant's own receipt-policy stream — never the body. A held over-tolerance
 * excess is decided by a second event, `GoodsReceiptExcessDecided`, appended atomically with the movements it
 * releases; the fold takes the latest per GRN id (append-only, hard rule #2).
 */
export function goodsReceiptAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<GoodsReceiptDeps, 'recordAudit'> {
  const grnStream = streamName(STREAM.purchase, 'grn');
  // Three event types, one register: the receipt as recorded, then (SP-4 (ii)) its excess decision, then (SP-6) each line
  // disposition — the fold takes them in append order, so the latest state of a GRN id wins.
  const fold = async (tenantId: string): Promise<readonly GrnRecord[]> => {
    const byId = new Map<string, GrnRecord>();
    for (const e of await input.store.readStream(tenantId, grnStream)) {
      if (e.event.type === 'GoodsReceived' || e.event.type === 'GoodsReceiptExcessDecided' || e.event.type === 'GoodsReceiptLineDisposed' || e.event.type === 'GoodsReceiptExcessReturned'
        || e.event.type === 'GoodsReceiptLineReturned') {
        const g = payloadOf<GrnRecord>(e);
        byId.set(g.grnId, g);
      }
    }
    return [...byId.values()];
  };
  /**
   * SP-6 (F01): a receipt's posting against its purchase order, in the purchase-order adapter's OWN event shape and key
   * (`po-<tenant>-<poId>-received-<receiptId>`), so `foldPurchaseOrders` nets it exactly as a manually posted receipt and a
   * retry of the same receipt collapses. Appended in the SAME batch as the GRN — the order and the stock change together.
   */
  const poReceiptEvent = (tenantId: string, p: PoReceiptPosting) => ({
    stream: PURCHASE_ORDERS_STREAM,
    event: makeEvent({
      id: `po-${p.poId}-received-${p.receiptId}`,
      type: 'PurchaseOrderReceiptPosted',
      occurredAt: p.at,
      idempotencyKey: `po-${tenantId}-${p.poId}-received-${p.receiptId}`,
      source: 'api/inventory',
      payload: { poId: p.poId, receiptId: p.receiptId, receivedByProduct: p.receivedByProduct, by: p.by, at: p.at, grnId: p.receiptId.split(':')[0] },
    }),
  });
  return {
    now: input.now,
    grn: async (tenantId, grnId) => (await fold(tenantId)).find((g) => g.grnId === grnId),
    all: fold,
    // SP-6 (F01): the purchase order as head office holds it — status and ordered quantity per product.
    // SF-02: with what earlier receipts received and cancellations took off — a receipt is judged against what REMAINS.
    purchaseOrder: async (tenantId, poId) => {
      const po = (await foldPurchaseOrders(input.store, tenantId)).get(poId);
      if (po === undefined) return undefined;
      const orderedByProduct: Record<string, number> = {};
      for (const line of po.lines) orderedByProduct[line.productId] = (orderedByProduct[line.productId] ?? 0) + line.orderedQty;
      return {
        status: po.status, orderedByProduct, receivedByProduct: po.receivedByProduct, cancelledByProduct: po.cancelledByProduct,
        ...(po.deliverToLocationId === undefined ? {} : { deliverToLocationId: po.deliverToLocationId }),
      };
    },
    orderVersion: (tenantId, poId) => input.store.guardVersion(tenantId, purchaseOrderGuardKey(poId)),
    // SF-02: under the order's guard when the receipt posts against it — two receipts never spend the same remainder.
    commit: async (tenantId, record, movements, key, poReceipt, orderGuard) => {
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
        ...movements.map((m) => movementEvent(tenantId, m)),
        ...(poReceipt === undefined ? [] : [poReceiptEvent(tenantId, poReceipt)]),
      ], orderGuard === undefined ? undefined : { guard: { key: purchaseOrderGuardKey(orderGuard.poId), expectedVersion: orderGuard.expectedVersion } });
    },
    // SP-6 (M07-FR-03): the disposition and the movement an accept releases — one append; one disposition per line.
    commitDisposition: async (tenantId, record, movements, key) => {
      await input.store.appendBatch(tenantId, [
        {
          stream: grnStream,
          event: makeEvent({
            id: `grn-disposition-${key}`,
            type: 'GoodsReceiptLineDisposed',
            occurredAt: input.now(),
            idempotencyKey: `grn-disposition-${tenantId}-${key}`,
            source: 'api/inventory',
            payload: record,
          }),
        },
        ...movements.map((m) => movementEvent(tenantId, m)),
      ]);
    },
    // SP-7b: the physical return of a rejected excess and the movements that take it off on-hand — one append, once per receipt.
    commitExcessReturn: async (tenantId, record, movements, key) => {
      await input.store.appendBatch(tenantId, [
        {
          stream: grnStream,
          event: makeEvent({
            id: `grn-excess-return-${key}`,
            type: 'GoodsReceiptExcessReturned',
            occurredAt: record.excessReturn?.returnedAt ?? input.now(),
            idempotencyKey: `grn-excess-return-${tenantId}-${record.grnId}`,
            source: 'api/inventory',
            payload: record,
          }),
        },
        ...movements.map((m) => movementEvent(tenantId, m)),
      ]);
    },
    // OB-31 · SF-11: the master's base unit for a product (else the published pack's), and its pack levels.
    productUom: async (tenantId, productId) => {
      const master = await productMasterAdapter(input).product(tenantId, productId);
      if (master?.baseUom !== undefined) return master.baseUom;
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return pack?.snapshot.products.find((p) => p.productId === productId)?.baseUom;
    },
    packOf: (tenantId, productId) => packHierarchyAdapter(input).pack(tenantId, productId),
    // GT-05 (store volume): the unit, pack levels and receiving rule of every product on a receipt from ONE fold of each
    // source — the same sources and the same rule as productUom / packOf / productRule above.
    productFacts: async (tenantId, productIds) => {
      const masters = new Map((await productMasterAdapter(input).products(tenantId)).map((m) => [m.productId, m] as const));
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      const published = new Map((pack?.snapshot.products ?? []).map((p) => [p.productId, p] as const));
      const levels = await packHierarchyAdapter(input).packs(tenantId);
      const out = new Map<string, ProductReceiptFacts>();
      for (const productId of productIds) {
        const master = masters.get(productId);
        const product = published.get(productId);
        const uom = master?.baseUom ?? product?.baseUom;
        const level = levels.get(productId);
        const rule = receiptRuleFor(productId, product, master, COLD_CHAIN_CLASS_DEFAULTS);
        out.set(productId, { ...(uom === undefined ? {} : { uom }), ...(level === undefined ? {} : { pack: level }), ...(rule === undefined ? {} : { rule }) });
      }
      return out;
    },
    // Batch 2: a quarantined line's physical return to the supplier — the receipt's next state, once per line.
    commitLineReturn: async (tenantId, record, key) => {
      await input.store.append(tenantId, grnStream, makeEvent({
        id: `grn-line-return-${key}`,
        type: 'GoodsReceiptLineReturned',
        occurredAt: record.lineReturns?.at(-1)?.returnedAt ?? input.now(),
        idempotencyKey: `grn-line-return-${tenantId}-${key}`,
        source: 'api/inventory',
        payload: record,
      }));
    },
    // The product master's word on tracking (F03): the published catalogue is the master the whole estate runs on.
    // Wave 3 · SF-07: batch tracking from the published catalogue (F03, as before); the handling class and cold-chain limits
    // from head office's PRODUCT MASTER, with the approved class defaults the pack uses — never the sender's word.
    productRule: async (tenantId, productId): Promise<ProductReceiptRules | undefined> => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      const product = pack?.snapshot.products.find((p) => p.productId === productId);
      const master = await productMasterAdapter(input).product(tenantId, productId);
      return receiptRuleFor(productId, product, master, COLD_CHAIN_CLASS_DEFAULTS);
    },
    receiptPolicy: (tenantId) => latest<StoredReceiptPolicy>(input.store, tenantId, RECEIPT_POLICY_STREAM, 'ReceiptPolicySet'),
    recordReceiptPolicy: async (tenantId, policy) => {
      await input.store.append(tenantId, RECEIPT_POLICY_STREAM, makeEvent({
        id: keyedEventId('receipt-policy', `receipt-policy-${tenantId}-${policy.setAt}-${policy.setBy}`),
        type: 'ReceiptPolicySet',
        occurredAt: policy.setAt,
        idempotencyKey: `receipt-policy-${tenantId}-${policy.setAt}-${policy.setBy}`,
        source: 'api/inventory',
        payload: policy,
      }));
    },
    // The decision and the movements it releases are ONE append (FND-01): the excess never reaches stock twice, and never
    // reaches it without the decision that allowed it.
    commitExcessDecision: async (tenantId, record, movements, key, poReceipt) => {
      const entries: BatchEntry[] = [
        {
          stream: grnStream,
          event: makeEvent({
            id: `grn-excess-${record.grnId}-${key}`,
            type: 'GoodsReceiptExcessDecided',
            occurredAt: record.excessDecision?.decidedAt ?? input.now(),
            // One decision per receipt: the decide step refuses a conflicting second one before it gets here.
            idempotencyKey: `grn-excess-${tenantId}-${record.grnId}`,
            source: 'api/inventory',
            payload: record,
          }),
        },
        ...movements.map((m) => movementEvent(tenantId, m)),
        // SP-6 (F01): an accepted excess is received against the order too — in the same append.
        ...(poReceipt === undefined ? [] : [poReceiptEvent(tenantId, poReceipt)]),
      ];
      // SF-02: an accepted excess moves the order, so a receipt judged before it is refused rather than doubled.
      if (poReceipt === undefined) await input.store.appendBatch(tenantId, entries);
      else await appendMovingOrder(input.store, tenantId, poReceipt.poId, entries);
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
    readonly taken: StockSnapshot | undefined;
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
      taken,
    };
  };

  /**
   * SF-03 — per-batch on-hand, from the SAME snapshot and tail as the product figure. A snapshot taken before SF-03 has no
   * batch balances: then (and only then) the batch read folds the ledger from the start — correct, slower, and gone once
   * the next snapshot is taken (it carries them).
   */
  const batchesFrom = async (tenantId: string, b: Awaited<ReturnType<typeof basis>>): Promise<readonly BatchBalance[]> => {
    if (b.taken === undefined || b.taken.batchBalances !== undefined) return projectBatches(b.tail, b.taken?.batchBalances ?? []);
    // Folded only up to the same sequence the tail ends at, so a snapshot built from it covers exactly what it says.
    const all = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
    return projectBatches(all.filter((e) => e.seq <= b.tailSeq).map((e) => payloadOf<Movement>(e)));
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

    batches: async (tenantId, productId) => {
      const rows = await batchesFrom(tenantId, await basis(tenantId));
      return productId === undefined ? rows : rows.filter((r) => r.productId === productId);
    },

    // SP-5 (F05 · M08-FR-02): what is on the van — every line of every transfer still in transit, held AT the destination,
    // read from the transfer aggregates (the authoritative record of the van) and never folded into on-hand.
    inTransit: async (tenantId, productId) =>
      (await foldTransferAggregates(input.store, tenantId))
        .filter((t) => t.state === 'in_transit')
        .flatMap((t) => t.lines
          .filter((l) => productId === undefined || l.productId === productId)
          .map((l): InTransitStock => ({
            transferId: t.transferId, productId: l.productId, batchId: l.batchId, locationId: t.toLocationId, fromLocationId: t.fromLocationId,
            quantityMinor: l.quantityMinor, uom: l.uom, dispatchedAt: t.dispatchedAt ?? '',
          })))
        .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.transferId < b.transferId ? -1 : 1)),

    // SP-5 (F05 · M09-FR-03): every valued receipt shortfall — stock that left and never arrived — from the received
    // transfers' own discrepancy records. Listed beside negative stock until a person owns it (P-08, #10).
    transferShortfalls: async (tenantId) => {
      const received = await input.store.readStream(tenantId, streamName(STREAM.warehouse, 'transfers'), { type: 'TransferReceived' });
      // Batch 2: a floor-indent shortfall a second person RESOLVED stays listed, beside its resolution (hard rule #6).
      const resolvedByTransfer = new Map<string, NonNullable<TransferShortfall['resolution']>>();
      for (const e of await input.store.readStream(tenantId, streamName(STREAM.warehouse, 'indents'), { type: 'FloorIndentShortfallResolved' })) {
        for (const issue of payloadOf<{ indent: FloorIndent }>(e).indent.issues) {
          const r = issue.shortfallResolution;
          if (r === undefined) continue;
          for (const l of r.lines) {
            resolvedByTransfer.set(`${issue.transferId}\u001f${l.productId}\u001f${l.batchId ?? ''}`, {
              resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt, reasonCode: r.reasonCode, note: r.note,
              foundMinor: l.foundMinor, lostMinor: l.lostMinor, lostValueMinor: l.lostValueMinor, movementIds: r.movementIds,
            });
          }
        }
      }
      for (const e of await input.store.readStream(tenantId, streamName(STREAM.warehouse, 'transfers'), { type: 'TransferShortfallResolved' })) {
        const t = payloadOf<{ transfer: Transfer }>(e).transfer;
        const r = t.shortfallResolution;
        if (r === undefined) continue;
        for (const l of r.lines) {
          resolvedByTransfer.set(`${t.transferId}\u001f${l.productId}\u001f${l.batchId ?? ''}`, {
            resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt, reasonCode: r.reasonCode, note: r.note,
            foundMinor: l.foundMinor, lostMinor: l.lostMinor, lostValueMinor: l.lostValueMinor, movementIds: r.movementIds,
          });
        }
      }
      const out: TransferShortfall[] = [];
      for (const e of received) {
        const p = payloadOf<{ transfer: Transfer; discrepancies?: readonly TransferDiscrepancy[] }>(e);
        for (const d of p.discrepancies ?? []) {
          if (d.differenceMinor >= 0) continue;
          out.push({
            transferId: p.transfer.transferId, productId: d.productId, batchId: d.batchId, fromLocationId: p.transfer.fromLocationId, locationId: p.transfer.toLocationId,
            dispatchedMinor: d.dispatchedMinor, receivedMinor: d.receivedMinor, differenceMinor: d.differenceMinor, value: d.value,
            receivedAt: p.transfer.receivedAt ?? e.event.occurredAt, detail: d.detail,
            resolution: resolvedByTransfer.get(`${p.transfer.transferId}\u001f${d.productId}\u001f${d.batchId ?? ''}`) ?? null,
          });
        }
      }
      return out;
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
          isPurchaseReceipt: carriesCost(m), isTransferOut: movesValueOnward(m.kind), minorPerUnit: minorPerUnitOf(m.uom), ...(m.unitCostPer === undefined ? {} : { costPerUnits: m.unitCostPer }), ...(m.kind === 'opening_reversed' ? { isReceiptReversal: true, ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }) } : {}),
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
    ageing: async (tenantId, productId, covers) => {
      const events = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
      const movements = events
        .map((e) => payloadOf<Movement>(e))
        .filter((m) => productId === undefined || m.productId === productId)
        // PA-01-r1: only the caller's locations — lots are pooled per location, so this is exactly their stock.
        .filter((m) => covers === undefined || covers(m.locationId));
      return agedStockLots(
        movements.map((m): DatedMovement => ({
          productId: m.productId, locationId: m.locationId,
          effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor,
          isPurchaseReceipt: carriesCost(m), isTransferOut: movesValueOnward(m.kind), minorPerUnit: minorPerUnitOf(m.uom), ...(m.unitCostPer === undefined ? {} : { costPerUnits: m.unitCostPer }), ...(m.kind === 'opening_reversed' ? { isReceiptReversal: true, ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }) } : {}),
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
    performance: async (tenantId, { from, to, covers }) => {
      // PA-01-r1: a branch-limited read folds only its own locations' movements, sales and returns. A sale or return that
      // names no location cannot be placed in a branch, so it is in no branch-limited read (only the 'all' read).
      const placed = (locationId: unknown): boolean => covers === undefined || (typeof locationId === 'string' && covers(locationId));
      const events = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
      const movements = events
        .map((e) => payloadOf<Movement>(e))
        .filter((m) => placed(m.locationId))
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
      // Cumulative WAC cogs and stock value PER PRODUCT at a cut point (summed across locations).
      const foldTo = (cutoff: string): Map<string, { cogs: number; value: number; onHand: number }> => {
        const rows = weightedAverageValuation(
          movements
            .filter((m) => m.occurredAt <= cutoff)
            .map((m): ValuationMovement => ({
              productId: m.productId, locationId: m.locationId,
              effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor,
              isPurchaseReceipt: carriesCost(m), isTransferOut: movesValueOnward(m.kind), minorPerUnit: minorPerUnitOf(m.uom), ...(m.unitCostPer === undefined ? {} : { costPerUnits: m.unitCostPer }), ...(m.kind === 'opening_reversed' ? { isReceiptReversal: true, ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }) } : {}),
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
        const sale = payloadOf<{ readonly locationId?: string; readonly lines: readonly { readonly productId: string; readonly lineTotalMinor: number }[] }>(e);
        if (!placed(sale.locationId)) continue;
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
        const ret = payloadOf<{ readonly locationId?: string; readonly originalSaleId: string | null; readonly refundMinor: number; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly disposition: string }[] }>(e);
        if (!placed(ret.locationId)) continue;
        // A no-receipt return (originalSaleId null, M13-FR-01) has no bill to price its lines from: its refund
        // is still a real reduction of net sales, so it is allocated across its lines by quantity (the only
        // weight it has) rather than dropped — P-08, never a silent zero.
        const saleEvent = ret.originalSaleId === null ? undefined : await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${ret.originalSaleId}`);
        const saleLines = saleEvent === undefined ? [] : (saleEvent.event.payload as { readonly lines: readonly { readonly productId: string; readonly unitPriceMinor: number }[] }).lines;
        const priceByProduct = new Map(saleLines.map((l) => [l.productId, l.unitPriceMinor]));
        const lineGross = ret.lines.map((l) => (priceByProduct.get(l.productId) ?? (ret.originalSaleId === null ? 1 : 0)) * l.quantityMinor);
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
            // OB-31: the closing value per smallest step (a gram of a kg product), taken in proportion and rounded once —
            // never a per-gram cost rounded to a whole paisa first.
            const back = c !== undefined && c.onHand > 0 ? Math.round((c.value * l.quantityMinor) / c.onHand) : 0;
            returnedCogsByProduct.set(l.productId, (returnedCogsByProduct.get(l.productId) ?? 0) + back);
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
      const b = await basis(tenantId);
      const { opening, tail, tailSeq } = b;
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
            batchBalances: await batchesFrom(tenantId, b),
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

/** Sum two `{ productId: qty }` maps (append-only accumulation of receipts / cancellations). */
function mergeQty(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** Value the PO's lines (ordered qty × unit cost) — recomputed when an amendment replaces the lines. */
function poTotalMinor(lines: StoredPurchaseOrder['lines']): number {
  // OB-31: a kilo / litre line is costed per kilo / litre while its quantity is in grams / millilitres.
  return lines.reduce((s, l) => s + valueAtCost(l.orderedQty, l.uom ?? 'ea', l.unitCost), 0);
}

/**
 * Fold the purchase-order stream to each PO's current state (M06-FR-02/04). `PurchaseOrderProposed`
 * opens it (first proposal of an id wins — a re-sync is idempotent); `PurchaseOrderIssued` moves it to
 * issued; `PurchaseOrderAmended` replaces the effective lines (the prior lines stay on the ledger, hard
 * rule #2); `PurchaseOrderCancelled` / `PurchaseOrderReceiptPosted` accumulate the cancelled / received
 * quantity per product. Both `purchaseOrdersAdapter` (reads) and `purchaseAdapter.openCommitments` fold
 * through here, so there is one truth for the open commitment.
 */
export async function foldPurchaseOrders(store: EventStore, tenantId: string): Promise<Map<string, StoredPurchaseOrder>> {
  const events = await store.readStream(tenantId, PURCHASE_ORDERS_STREAM); // all types, oldest first
  const byId = new Map<string, StoredPurchaseOrder>();
  for (const e of events) {
    const type = e.event.type;
    if (type === 'PurchaseOrderProposed') {
      const po = payloadOf<StoredPurchaseOrder>(e);
      if (!byId.has(po.poId)) byId.set(po.poId, { ...po, receivedByProduct: {}, cancelledByProduct: {}, amendmentCount: 0 });
    } else if (type === 'PurchaseOrderIssued') {
      const iss = payloadOf<{ poId: string; approvedBy: string; issuedAt: string }>(e);
      const cur = byId.get(iss.poId);
      if (cur !== undefined && cur.status === 'proposed') {
        byId.set(iss.poId, { ...cur, status: 'issued', approvedBy: iss.approvedBy, issuedAt: iss.issuedAt });
      }
    } else if (type === 'PurchaseOrderAmended') {
      const am = payloadOf<{ poId: string; lines: StoredPurchaseOrder['lines'] }>(e);
      const cur = byId.get(am.poId);
      if (cur !== undefined) byId.set(am.poId, { ...cur, lines: am.lines, totalMinor: poTotalMinor(am.lines), amendmentCount: cur.amendmentCount + 1 });
    } else if (type === 'PurchaseOrderCancelled') {
      const c = payloadOf<{ poId: string; cancelledByProduct: Record<string, number> }>(e);
      const cur = byId.get(c.poId);
      if (cur !== undefined) byId.set(c.poId, { ...cur, cancelledByProduct: mergeQty(cur.cancelledByProduct, c.cancelledByProduct) });
    } else if (type === 'PurchaseOrderReceiptPosted') {
      const r = payloadOf<{ poId: string; receivedByProduct: Record<string, number> }>(e);
      const cur = byId.get(r.poId);
      if (cur !== undefined) byId.set(r.poId, { ...cur, receivedByProduct: mergeQty(cur.receivedByProduct, r.receivedByProduct) });
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

    // OB-31: the master's unit for a product (else the published pack's) — a PO line's quantity is in its smallest steps.
    productUom: async (tenantId, productId) => {
      const master = await productMasterAdapter(input).product(tenantId, productId);
      if (master?.baseUom !== undefined) return master.baseUom;
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return pack?.snapshot.products.find((p) => p.productId === productId)?.baseUom;
    },
    // FUL-11: the store's range, enforced at ordering.
    rangeStatus: async (tenantId, storeId, productId, onDate) =>
      rangeStatusOf(await allOf<AssortmentEntry>(input.store, tenantId, forAssortment(storeId), 'AssortmentEntryRecorded'), storeId, productId, onDate),
    // OB-37: the org node an order's "deliver to" names — the hierarchy's word, never the body's.
    orgLocation: async (tenantId, locationId) => {
      const node = (await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId)).find((n) => n.nodeId === locationId);
      return node === undefined ? undefined : { kind: node.kind, status: node.status };
    },
    // OB-32 "A": the supplier master's word on this supplier — active (approved), proposed (waiting), or unknown.
    supplierStatus: async (tenantId, supplierId) => (await foldSupplierRecords(input.store, tenantId)).get(supplierId)?.status,

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

    issue: async (tenantId, poId, approvedBy, issuedAt, reason, _key, budgetGuard) => {
      const event = makeEvent({
        id: `po-${poId}-issued`,
        type: 'PurchaseOrderIssued',
        occurredAt: issuedAt,
        // Keyed on the PO id: a re-issue of an already-issued PO collapses (idempotent §31.1).
        idempotencyKey: `po-${tenantId}-${poId}-issued`,
        source: 'api/purchase',
        payload: { poId, approvedBy, issuedAt, reason },
      });
      // WF-03 (round 10): under the month's open-to-buy guard when a budget governs the order (two approvals: one lands).
      if (budgetGuard === undefined) await input.store.append(tenantId, PURCHASE_ORDERS_STREAM, event);
      else await input.store.appendBatch(tenantId, [{ stream: PURCHASE_ORDERS_STREAM, event }], { guard: budgetGuard });
    },

    orderVersion: (tenantId, poId) => input.store.guardVersion(tenantId, purchaseOrderGuardKey(poId)),
    amend: async (tenantId, poId, amendmentId, lines, reason, by, at, budgetGuard, orderVersion) => {
      // OB-63: an amendment that RAISES the order under a budget also spends the month's open-to-buy — under that guard too.
      // Round 13 (verifier A4): pinned to the order version the route judged on — a change since refuses it, never re-tried.
      await appendMovingOrder(input.store, tenantId, poId, [{ stream: PURCHASE_ORDERS_STREAM, event: makeEvent({
        id: `po-${poId}-amended-${amendmentId}`,
        type: 'PurchaseOrderAmended',
        occurredAt: at,
        // Keyed on the amendment id: a re-sent amendment collapses; each distinct amendment is retained.
        idempotencyKey: `po-${tenantId}-${poId}-amended-${amendmentId}`,
        source: 'api/purchase',
        payload: { poId, amendmentId, lines, reason, by, at },
      }) }], budgetGuard, orderVersion);
    },

    cancel: async (tenantId, poId, cancellationId, cancelledByProduct, reason, by, at) => {
      await appendMovingOrder(input.store, tenantId, poId, [{ stream: PURCHASE_ORDERS_STREAM, event: makeEvent({
        id: `po-${poId}-cancelled-${cancellationId}`,
        type: 'PurchaseOrderCancelled',
        occurredAt: at,
        // Keyed on the cancellation id so a re-send collapses; distinct cancellations accumulate.
        idempotencyKey: `po-${tenantId}-${poId}-cancelled-${cancellationId}`,
        source: 'api/purchase',
        payload: { poId, cancellationId, cancelledByProduct, reason, by, at },
      }) }]);
    },

    postReceipt: async (tenantId, poId, receiptId, receivedByProduct, by, at) => {
      await appendMovingOrder(input.store, tenantId, poId, [{ stream: PURCHASE_ORDERS_STREAM, event: makeEvent({
        id: `po-${poId}-received-${receiptId}`,
        type: 'PurchaseOrderReceiptPosted',
        occurredAt: at,
        // Keyed on the receipt id so a re-post collapses; distinct receipts accumulate.
        idempotencyKey: `po-${tenantId}-${poId}-received-${receiptId}`,
        source: 'api/purchase',
        payload: { poId, receiptId, receivedByProduct, by, at },
      }) }]);
    },

    setSupplierBlocked: async (tenantId, supplierId, blocked, reason, by, at) => {
      await input.store.append(tenantId, SUPPLIER_BLOCK_STREAM, makeEvent({
        id: keyedEventId('supplier-block', `supplier-block-${tenantId}-${supplierId}-${blocked}-${at}`),
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

/**
 * The supplier-performance store (M06-FR-03). Delivery OUTCOMES are recorded per supplier — latest per
 * PO, so a corrected outcome supersedes rather than double-counting a delivery in the score — and
 * contracts sit on one shared stream, latest per contract id (a renegotiated term is a new version,
 * hard rule #2). The scorecard read runs the tested `scoreSupplier` over these facts; the contract
 * alerts read runs `reviewContracts`.
 */
export function supplierScorecardAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SupplierScorecardDeps {
  const foldContracts = async (tenantId: string): Promise<SupplierContract[]> => {
    const events = await input.store.readStream(tenantId, SUPPLIER_CONTRACTS_STREAM, { type: 'SupplierContractRecorded' });
    const byId = new Map<string, SupplierContract>();
    for (const e of events) {
      const c = payloadOf<SupplierContract>(e);
      byId.set(c.contractId, c); // occurrence order → the last version of a contract wins
    }
    return [...byId.values()];
  };
  return {
    now: input.now,

    receipts: async (tenantId, supplierId) => {
      const all = await allOf<ReceiptFact>(input.store, tenantId, forSupplierPerformance(supplierId), 'SupplierReceiptRecorded');
      const byPo = new Map<string, ReceiptFact>();
      for (const r of all) byPo.set(r.poId, r); // latest outcome per PO wins
      return [...byPo.values()];
    },

    contractsFor: async (tenantId, supplierId) => (await foldContracts(tenantId)).filter((c) => c.supplierId === supplierId),
    allContracts: (tenantId) => foldContracts(tenantId),

    recordReceipt: async (tenantId, fact) => {
      // A compact digest of the outcome so a re-send of the SAME delivery collapses (idempotent), but a
      // CORRECTION (a different quantity/date/value) is a new fact the latest-per-PO fold then supersedes with.
      const digest = `${fact.orderedOn}-${fact.receivedOn}-${fact.orderedQtyMinor}-${fact.receivedQtyMinor}-${fact.rejectedQtyMinor ?? 0}-${fact.agreedValue.minor}-${fact.invoicedValue.minor}-${fact.agreedValue.currency}`;
      await input.store.append(tenantId, forSupplierPerformance(fact.supplierId), makeEvent({
        id: `supplier-receipt-${fact.supplierId}-${fact.poId}-${digest}`,
        type: 'SupplierReceiptRecorded',
        occurredAt: input.now(),
        idempotencyKey: `supplier-receipt-${tenantId}-${fact.supplierId}-${fact.poId}-${digest}`,
        source: 'api/purchase',
        payload: fact,
      }));
    },

    recordContract: async (tenantId, contract) => {
      await input.store.append(tenantId, SUPPLIER_CONTRACTS_STREAM, makeEvent({
        id: `supplier-contract-${contract.contractId}-${contract.startsOn}-${contract.endsOn}`,
        type: 'SupplierContractRecorded',
        occurredAt: input.now(),
        // Keyed on the id + its term + lead time: re-recording the same terms collapses, a renegotiation is new.
        idempotencyKey: `supplier-contract-${tenantId}-${contract.contractId}-${contract.startsOn}-${contract.endsOn}-${contract.agreedLeadTimeDays}-${contract.approvedBy ?? 'unapproved'}`,
        source: 'api/purchase',
        payload: contract,
      }));
    },
  };
}

/**
 * The rebate store (M06-FR-03 · M23). Schemes live on one shared stream (latest per scheme id — a
 * renegotiation is a new version, hard rule #2); accruals live on a per-scheme stream (latest per
 * accrual id, so a re-measure with a new received figure supersedes rather than double-counting). The
 * accrual computation itself is the tested `accrueRebate`, run in the route.
 */
export function rebatesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): RebateDeps {
  const foldSchemes = async (tenantId: string): Promise<Map<string, RebateScheme>> => {
    const events = await input.store.readStream(tenantId, REBATE_SCHEMES_STREAM, { type: 'RebateSchemeRecorded' });
    const byId = new Map<string, RebateScheme>();
    for (const e of events) {
      const s = payloadOf<RebateScheme>(e);
      byId.set(s.schemeId, s); // occurrence order → the last version of a scheme wins
    }
    return byId;
  };
  return {
    now: input.now,
    scheme: async (tenantId, schemeId) => (await foldSchemes(tenantId)).get(schemeId),
    schemes: async (tenantId) => [...(await foldSchemes(tenantId)).values()],

    accruals: async (tenantId, schemeId) => {
      const events = await input.store.readStream(tenantId, forRebateAccruals(schemeId), { type: 'RebateAccrued' });
      const byId = new Map<string, RebateAccrual>();
      for (const e of events) {
        const p = payloadOf<{ accrualId: string; accrual: RebateAccrual }>(e);
        byId.set(p.accrualId, p.accrual); // latest measurement per accrual id wins
      }
      return [...byId.values()];
    },

    recordScheme: async (tenantId, scheme) => {
      await input.store.append(tenantId, REBATE_SCHEMES_STREAM, makeEvent({
        id: `rebate-scheme-${scheme.schemeId}-${scheme.startsOn}-${scheme.endsOn}-${scheme.rateBp}`,
        type: 'RebateSchemeRecorded',
        occurredAt: input.now(),
        // Keyed on the id + its terms: re-recording the same scheme collapses, a renegotiation is new.
        idempotencyKey: `rebate-scheme-${tenantId}-${scheme.schemeId}-${scheme.basis}-${scheme.rateBp}-${scheme.thresholdMinor ?? 0}-${scheme.startsOn}-${scheme.endsOn}-${scheme.approvedBy ?? 'unapproved'}`,
        source: 'api/purchase',
        payload: scheme,
      }));
    },

    recordAccrual: async (tenantId, schemeId, accrualId, accrual) => {
      await input.store.append(tenantId, forRebateAccruals(schemeId), makeEvent({
        id: `rebate-accrual-${schemeId}-${accrualId}-${accrual.accrued.minor}-${accrual.received.minor}`,
        type: 'RebateAccrued',
        occurredAt: input.now(),
        // Keyed on the accrual id + the computed figures: a re-post of the same measurement collapses,
        // but a re-measure (a new basis or a payment received) is a new fact the latest-per-id fold takes.
        idempotencyKey: `rebate-accrual-${tenantId}-${schemeId}-${accrualId}-${accrual.accrued.minor}-${accrual.received.minor}-${accrual.outstanding.minor}`,
        source: 'api/purchase',
        payload: { accrualId, accrual },
      }));
    },
  };
}

/**
 * The RFQ store (M06-FR-02). Requisitions live on one shared stream (latest per id); the quotes for a
 * requisition live on its own stream (latest per quote id, so a re-quote supersedes and the comparison
 * always reflects the newest offer). The comparison itself is the tested `compareQuotes`, run in the route.
 */
export function rfqAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): RfqDeps {
  const foldRequisitions = async (tenantId: string): Promise<Map<string, Requisition>> => {
    const events = await input.store.readStream(tenantId, REQUISITIONS_STREAM, { type: 'RequisitionRaised' });
    const byId = new Map<string, Requisition>();
    for (const e of events) {
      const r = payloadOf<Requisition>(e);
      byId.set(r.requisitionId, r); // occurrence order → the last version of a requisition wins
    }
    return byId;
  };
  return {
    now: input.now,
    requisition: async (tenantId, requisitionId) => (await foldRequisitions(tenantId)).get(requisitionId),
    requisitions: async (tenantId) => [...(await foldRequisitions(tenantId)).values()],

    quotes: async (tenantId, requisitionId) => {
      const events = await input.store.readStream(tenantId, forRfqQuotes(requisitionId), { type: 'QuoteRecorded' });
      const byId = new Map<string, Quote>();
      for (const e of events) {
        const q = payloadOf<Quote>(e);
        byId.set(q.quoteId, q); // latest quote per id wins
      }
      return [...byId.values()];
    },

    recordRequisition: async (tenantId, requisition) => {
      // Keyed on a digest of the lines so a re-send collapses but an edited requisition is a new version.
      const digest = requisition.lines.map((l) => `${l.productId}:${l.quantity}`).sort().join(',');
      await input.store.append(tenantId, REQUISITIONS_STREAM, makeEvent({
        id: `requisition-${requisition.requisitionId}-${requisition.currency}-${digest}`,
        type: 'RequisitionRaised',
        occurredAt: input.now(),
        idempotencyKey: `requisition-${tenantId}-${requisition.requisitionId}-${requisition.currency}-${digest}`,
        source: 'api/purchase',
        payload: requisition,
      }));
    },

    recordQuote: async (tenantId, requisitionId, quote) => {
      // Keyed on a digest of the quoted lines so a re-send collapses but a re-quote (new price/lead) supersedes.
      const digest = quote.lines.map((l) => `${l.productId}:${l.unitCost.minor}:${l.unitCost.currency}:${l.leadTimeDays}`).sort().join(',');
      await input.store.append(tenantId, forRfqQuotes(requisitionId), makeEvent({
        id: `quote-${requisitionId}-${quote.quoteId}-${digest}`,
        type: 'QuoteRecorded',
        occurredAt: input.now(),
        idempotencyKey: `quote-${tenantId}-${requisitionId}-${quote.quoteId}-${digest}`,
        source: 'api/purchase',
        payload: quote,
      }));
    },
  };
}

/**
 * Import job history & data-quality store (M30-FR-04). Every recorded job outcome is an append-only
 * `ImportJobRecorded` fact on one shared stream — **refusals kept alongside successes** (hard rule #6),
 * because a history of only the successes is how a file that fails half the time looks perfect. Folded
 * latest-per-jobId so a re-send of the same outcome collapses; the score/history reads run the tested
 * `@sre/import` engine over the fold.
 */
export function importQualityAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ImportQualityDeps {
  const foldJobs = async (tenantId: string): Promise<readonly ImportJobRecord[]> => {
    const all = await allOf<ImportJobRecord>(input.store, tenantId, IMPORT_JOBS_STREAM, 'ImportJobRecorded');
    const byId = new Map<string, ImportJobRecord>();
    for (const j of all) byId.set(j.jobId, j);
    return [...byId.values()];
  };
  return {
    now: input.now,
    jobs: (tenantId) => foldJobs(tenantId),
    recordImportJob: async (tenantId, jobId, record, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, IMPORT_JOBS_STREAM, makeEvent({
        id: `import-job-${jobId}-${d}`,
        type: 'ImportJobRecorded',
        occurredAt: input.now(),
        idempotencyKey: `import-job-${tenantId}-${jobId}-${d}`,
        source: 'api/purchase',
        payload: record,
      }));
    },
  };
}

const LEGAL_HOLDS_STREAM = streamName(STREAM.platform, 'legal-holds');

/**
 * Legal-hold store (M34-FR-02 / hard rule #6). Every place / lift is an append-only `LegalHold` fact —
 * a hold that freezes evidence past its retention date, and its release recorded as a NEW state so the
 * hold itself is never erased (it must be provable a year later what was frozen, by whom, and when it was
 * released). The routes run the tested `@sre/audit` engine over the fold; this only stores the facts.
 */
export function legalHoldsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): LegalHoldsDeps {
  return {
    now: input.now,
    holds: async (tenantId) => projectHolds(await allOf<LegalHoldEvent>(input.store, tenantId, LEGAL_HOLDS_STREAM, 'LegalHold')),
    recordHoldEvent: async (tenantId, event, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, LEGAL_HOLDS_STREAM, makeEvent({
        id: `legal-hold-${event.holdId}-${event.change}-${d}`,
        type: 'LegalHold',
        occurredAt: event.at,
        idempotencyKey: `legal-hold-${tenantId}-${event.holdId}-${event.change}-${d}`,
        source: 'api/finance',
        payload: event,
      }));
    },
  };
}

const ALERTS_STREAM = streamName(STREAM.platform, 'alerts');

/**
 * Alert lifecycle store (M35-FR-04). Every raise / acknowledge / escalate is an append-only `AlertLifecycle`
 * fact on one shared stream — an alert nobody acknowledges in time escalates to a named person, and the
 * escalation is kept as evidence (P-08, hard rule #6). The routes run the tested `@sre/ops` engines
 * (`raiseAlerts` / `escalateUnacknowledged`) over the fold; this only stores the facts.
 */
/**
 * Round 32 · OB-115 / round 33 · OB-119: does this person hold the owner role, and the IT/platform administration function —
 * who may change a built-in alert rule, and who may acknowledge a built-in alert (read from the grants, never written in code).
 */
async function builtInAuthorityOf(store: EventStore, tenantId: string, userId: string): Promise<{ owner: boolean; platformAdministration: boolean }> {
  const mine = (await effectiveGrants(store, tenantId)).filter((g) => g.userId === userId);
  return {
    owner: mine.some((g) => g.roleId === OWNER_ROLE_ID),
    platformAdministration: mine.some((g) => { const role = ROLE_CATALOGUE.find((r) => r.id === g.roleId); return role !== undefined && isPlatformAdministrationRole(role); }),
  };
}

export function alertLifecycleAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): AlertLifecycleDeps {
  return {
    now: input.now,
    // Round 33 · OB-119: only the owner acknowledges a built-in alert (the IT administrator is refused by name).
    builtInAlertAuthorityOf: (tenantId, userId) => builtInAuthorityOf(input.store, tenantId, userId),
    alerts: async (tenantId) =>
      projectAlerts(await allOf<AlertLifecycleEvent>(input.store, tenantId, ALERTS_STREAM, 'AlertLifecycle')),
    recordAlertEvent: async (tenantId, event, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, ALERTS_STREAM, makeEvent({
        id: `alert-${event.alertId}-${event.change}-${d}`,
        type: 'AlertLifecycle',
        occurredAt: event.at,
        idempotencyKey: `alert-${tenantId}-${event.alertId}-${event.change}-${d}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

const DATA_EXPORTS_STREAM = streamName(STREAM.platform, 'data-exports');

/**
 * Data-export audit ledger (M30-FR-02 / hard rule #6). Every domain export is an append-only
 * `DataExported` fact — who took what domain, when, how many rows, and which columns were redacted
 * for them — because the audit record is the only evidence afterwards of who extracted the shop's
 * data. The export routes run the tested `@sre/export` engine; this only stores the outcome. The id
 * is derived from the export route's idempotency key so a replay collapses to one logged export.
 */
export function dataExportAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DataExportAuditDeps {
  return {
    now: input.now,
    exports: async (tenantId) => allOf<ExportAudit>(input.store, tenantId, DATA_EXPORTS_STREAM, 'DataExported'),
    recordExport: async (tenantId, record, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, DATA_EXPORTS_STREAM, makeEvent({
        id: `data-export-${d}`,
        type: 'DataExported',
        occurredAt: record.at,
        idempotencyKey: `data-export-${tenantId}-${d}`,
        source: 'api/platform',
        payload: record,
      }));
    },
  };
}

const DATA_IMPORTS_STREAM = streamName(STREAM.purchase, 'data-imports');

/**
 * Bulk data-import commit ledger (M30-FR-01/03). Each approved, reconciled load is an append-only
 * `ImportCommitted` fact — who loaded what, who approved it, how many rows — so an import is auditable and
 * never silently applied (hard rule #2/#6). The validate/commit routes run the tested `@sre/import` engine;
 * this only stores the committed outcome (the commit route's 409 guard keeps one commit per job id).
 */
export function dataImportAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DataImportDeps {
  /** One real record an approved load writes (SF-06-a) — the SAME event, stream and key the record's own route uses, so
   *  everything that reads that register sees it, and a re-sent load collapses onto the first. */
  const effectEntry = (tenantId: string, e: ImportEffect, jobId: string, at: string): BatchEntry => (e.kind === 'supplier_invoice'
    ? {
        stream: SUPPLIER_INVOICES_STREAM,
        event: makeEvent({
          id: `invoice-${e.invoice.invoiceId}`, type: 'SupplierInvoiceCaptured', occurredAt: e.invoice.capturedAt,
          idempotencyKey: `invoice-${tenantId}-${e.invoice.invoiceId}`, source: 'api/purchase/import', payload: e.invoice,
        }),
      }
    : {
        // A product the load publishes — the product master's own event and stream (SF-06-b).
        stream: PRODUCTS_STREAM,
        event: makeEvent({
          id: `product-${e.product.productId}-import-${jobId}`, type: 'ProductPublished', occurredAt: at,
          idempotencyKey: `product-${tenantId}-${e.product.productId}-import-${jobId}`, source: 'api/purchase/import', payload: e.product,
        }),
      });
  return {
    now: input.now,
    commits: async (tenantId) => {
      const rollbacks = new Map((await allOf<ImportRollbackRecord>(input.store, tenantId, DATA_IMPORTS_STREAM, 'ImportRolledBack')).map((r) => [r.jobId, r] as const));
      return (await allOf<ImportCommitRecord>(input.store, tenantId, DATA_IMPORTS_STREAM, 'ImportCommitted'))
        .map((c) => (rollbacks.has(c.jobId) ? { ...c, rolledBack: rollbacks.get(c.jobId)! } : c));
    },
    recordCommit: async (tenantId, record, key, effects) => {
      // GT-05: a product the load publishes is indexed by its SKU like any other publish (the index is built first).
      if (effects.some((e) => e.kind === 'product' || e.kind === 'product_update')) await ensureSkuIndex(input.store, tenantId);
      // ONE atomic save: the job's record and every real record it applies — never one without the other.
      await input.store.appendBatch(tenantId, [
        ...effects.map((e) => effectEntry(tenantId, e, record.jobId, record.at)),
        ...effects.flatMap((e) => (e.kind === 'product' || e.kind === 'product_update' ? skuIndexEntries(tenantId, e.product, `import-${record.jobId}`, record.at) : [])),
        {
          stream: DATA_IMPORTS_STREAM,
          event: makeEvent({
            id: `data-import-${record.jobId}`, type: 'ImportCommitted', occurredAt: record.at,
            idempotencyKey: `data-import-${tenantId}-${key}`, source: 'api/purchase', payload: record,
          }),
        },
      ]);
    },
    recordRollback: async (tenantId, record) => {
      // Compensating records (append-only, §29.1): each invoice the load captured is WITHDRAWN, never deleted; each product
      // it published gets a new DISCONTINUED version (the published one stays as evidence).
      const products = new Map((await allOf<ProductRecord>(input.store, tenantId, PRODUCTS_STREAM, 'ProductPublished')).map((p) => [p.productId, p] as const));
      // M30 round 8: a product the load CHANGED goes back to the version that load replaced — the one published just before it.
      const replaced = new Map<string, ProductRecord>();
      if (record.effects.some((e) => e.kind === 'product_update')) {
        const last = new Map<string, ProductRecord>();
        for (const ev of await input.store.readStream(tenantId, PRODUCTS_STREAM, { type: 'ProductPublished' })) {
          const p = payloadOf<ProductRecord>(ev);
          if (ev.event.id === `product-${p.productId}-import-${record.jobId}` && last.has(p.productId)) replaced.set(p.productId, last.get(p.productId)!);
          last.set(p.productId, p);
        }
      }
      await input.store.appendBatch(tenantId, [
        ...record.effects.filter((e) => e.kind === 'product_update' && replaced.has(e.ref)).map((e) => ({
          stream: PRODUCTS_STREAM,
          event: makeEvent({
            id: `product-${e.ref}-rollback-${record.jobId}`, type: 'ProductPublished', occurredAt: record.at,
            idempotencyKey: `product-${tenantId}-${e.ref}-rollback-${record.jobId}`, source: 'api/purchase/import-rollback',
            payload: replaced.get(e.ref)!,
          }),
        })),
        ...record.effects.filter((e) => e.kind === 'product' && products.has(e.ref)).map((e) => ({
          stream: PRODUCTS_STREAM,
          event: makeEvent({
            id: `product-${e.ref}-rollback-${record.jobId}`, type: 'ProductPublished', occurredAt: record.at,
            idempotencyKey: `product-${tenantId}-${e.ref}-rollback-${record.jobId}`, source: 'api/purchase/import-rollback',
            payload: { ...products.get(e.ref)!, lifecycle: 'discontinued' as const },
          }),
        })),
        ...record.effects.filter((e) => e.kind === 'supplier_invoice').map((e) => ({
          stream: SUPPLIER_INVOICES_STREAM,
          event: makeEvent({
            id: `invoice-withdrawn-${e.ref}`, type: INVOICE_WITHDRAWN, occurredAt: record.at,
            idempotencyKey: `invoice-withdrawn-${tenantId}-${e.ref}`, source: 'api/purchase/import',
            payload: { invoiceId: e.ref, byImportRollback: record.jobId, requestedBy: record.requestedBy, approvedBy: record.approvedBy, reason: record.reason, at: record.at },
          }),
        })),
        {
          stream: DATA_IMPORTS_STREAM,
          event: makeEvent({
            id: `data-import-rollback-${record.jobId}`, type: 'ImportRolledBack', occurredAt: record.at,
            idempotencyKey: `data-import-rollback-${tenantId}-${record.jobId}`, source: 'api/purchase', payload: record,
          }),
        },
      ]);
    },
  };
}

/** A supplier invoice taken back out by a compensating record (SF-06-a rollback) — the capture stays as evidence. */
export const INVOICE_WITHDRAWN = 'SupplierInvoiceWithdrawn';

/** The supplier invoices head office holds now: every capture, less the ones withdrawn. */
export async function liveSupplierInvoices(store: EventStore, tenantId: string): Promise<readonly SupplierInvoiceRecord[]> {
  const withdrawn = new Set((await allOf<{ invoiceId: string }>(store, tenantId, SUPPLIER_INVOICES_STREAM, INVOICE_WITHDRAWN)).map((w) => w.invoiceId));
  return (await allOf<SupplierInvoiceRecord>(store, tenantId, SUPPLIER_INVOICES_STREAM, 'SupplierInvoiceCaptured')).filter((r) => !withdrawn.has(r.invoiceId));
}

/** True when this invoice id was EVER captured (withdrawn included) — an invoice id is never reused. */
export async function supplierInvoiceIdUsed(store: EventStore, tenantId: string, invoiceId: string): Promise<boolean> {
  return (await allOf<SupplierInvoiceRecord>(store, tenantId, SUPPLIER_INVOICES_STREAM, 'SupplierInvoiceCaptured')).some((r) => r.invoiceId === invoiceId);
}

/** OB-31: the unit head office counts a product in — the product master's base unit, else the published pack's. */
/**
 * M07-FR-02 (round 4 acceptance): the unit cost (minor, per whole unit) an ISSUED purchase order agreed for a product — the
 * cost a receipt against that order is posted at. Undefined when the order is unknown, not issued, or does not name it.
 */
export async function orderUnitCostFrom(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, poId: string, productId: string): Promise<number | undefined> {
  const po = (await foldPurchaseOrders(input.store, tenantId)).get(poId);
  if (po === undefined || po.status !== 'issued') return undefined;
  return po.lines.find((l) => l.productId === productId)?.unitCost.minor;
}

export async function productUomFrom(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, productId: string): Promise<string | undefined> {
  const master = await productMasterAdapter(input).product(tenantId, productId);
  if (master?.baseUom !== undefined) return master.baseUom;
  const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
  return pack?.snapshot.products.find((p) => p.productId === productId)?.baseUom;
}

export function purchaseAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PurchaseDeps {
  return {
    now: input.now,
    // OB-31: the master's unit for a product (else the published pack's) — an invoice line naming none is in this unit.
    productUom: (tenantId, productId) => productUomFrom(input, tenantId, productId),

    // SP-7a (F02 · F04): the supplier invoice is a RECORD on its own register — the invoice's own lines, who captured it,
    // who checked it — keyed on the invoice id, so a retry (a lost reply, a re-sent screen queue) never doubles what a
    // supplier is owed. The match reads it here beside the order register and the receipts folded into the order (SP-6);
    // nothing about the order or the delivery is ever taken from a body again.
    invoice: async (tenantId, invoiceId) => (await liveSupplierInvoices(input.store, tenantId)).find((r) => r.invoiceId === invoiceId),
    invoices: (tenantId) => liveSupplierInvoices(input.store, tenantId),
    invoiceIdUsed: (tenantId, invoiceId) => supplierInvoiceIdUsed(input.store, tenantId, invoiceId),
    // D03-FR-02 (round 12): the scan a typed capture names, and the append-only link that marks it typed.
    invoiceDocument: async (tenantId, documentId) => (await foldInvoiceDocuments(input.store, tenantId)).find((d) => d.documentId === documentId),
    recordScanTyped: (tenantId, link, invoice) => recordInvoiceDocumentTyped(input.store, tenantId, link, invoice === undefined ? undefined : { stream: SUPPLIER_INVOICES_STREAM, event: supplierInvoiceCapturedEvent(tenantId, invoice) }),
    recordInvoice: async (tenantId, record) => {
      await input.store.append(tenantId, SUPPLIER_INVOICES_STREAM, supplierInvoiceCapturedEvent(tenantId, record));
    },
    purchaseOrder: async (tenantId, poId) => (await foldPurchaseOrders(input.store, tenantId)).get(poId),
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    latestMatch: async (tenantId, invoiceId) => {
      const all = await allOf<StoredMatch>(input.store, tenantId, STREAM.purchase, 'InvoiceMatched');
      return all.filter((m) => m.invoiceId === invoiceId).at(-1);
    },

    // SP-7c (M06-FR-01 · §28): who created the supplier's master record — they may never approve its bank details.
    supplierCreatedBy: async (tenantId, supplierId) => (await latestSupplierRecord(input.store, tenantId, supplierId))?.createdBy,
    // SP-7b: the tenant's match tolerances — set by the owner, applied by /match, said on every verdict. Latest wins.
    matchPolicy: (tenantId) => latest<StoredMatchPolicy>(input.store, tenantId, MATCH_POLICY_STREAM, 'MatchPolicySet'),
    recordMatchPolicy: async (tenantId, policy) => {
      await input.store.append(tenantId, MATCH_POLICY_STREAM, makeEvent({
        id: keyedEventId('match-policy', `match-policy-${tenantId}-${policy.setAt}-${policy.setBy}`),
        type: 'MatchPolicySet',
        occurredAt: policy.setAt,
        idempotencyKey: `match-policy-${tenantId}-${policy.setAt}-${policy.setBy}`,
        source: 'api/purchase',
        payload: policy,
      }));
    },

    recordMatch: async (tenantId, invoiceId, r) => {
      const outcome = (m: { payableMinor: number; invoicedMinor: number; poId?: string | null | undefined; blocked: boolean }): string =>
        `${m.payableMinor}-${m.invoicedMinor}-${m.poId ?? ''}-${m.blocked ? 'blocked' : 'clear'}`;
      // Keyed on the *outcome*, not just the invoice, AND the match it supersedes. Re-running an unchanged match collapses;
      // a match that now pays a different figure — or that is no longer blocked because the tenant's tolerances changed
      // (SP-7b) — is a different fact and must be recorded, or the ledger would show the first answer forever; and an
      // outcome that goes BACK to an earlier one (clear → blocked → clear) is in force too (hard rule #10, verifier r18).
      await appendSetting(input.store, tenantId, STREAM.purchase, {
        type: 'InvoiceMatched', idPrefix: `match-${invoiceId}`, valueKey: `match-${tenantId}-${invoiceId}-${outcome(r)}`,
        occurredAt: r.matchedAt, source: 'api/purchase', payload: r,
        sameSubject: (p) => (p as StoredMatch).invoiceId === invoiceId,
        subjectKey: invoiceId,
        sameValue: (p) => outcome(p as StoredMatch) === outcome(r),
      });
    },

    applyBankChange: async (tenantId, r) => {
      const bankKey = `bank-${tenantId}-${r.supplierId}-${r.newAccount}-${r.requestedAt}`;
      await input.store.append(tenantId, STREAM.purchase, makeEvent({
        id: keyedEventId(`bank-${r.supplierId}`, bankKey),
        type: 'SupplierBankChanged',
        occurredAt: input.now(),
        // The request's own date is in the key. Without it a supplier who moved to a new account
        // and later moved back would have the return collapse into the original change as a
        // replay — and the ledger would then assert the money still goes to the middle account.
        idempotencyKey: bankKey,
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
      // ordered − received − cancelled, netted per PO, then summed (M06-FR-04).
      const valueMinor = issued.reduce(
        (sum, po) => sum + computeOpenCommitment(po.lines, po.receivedByProduct, po.cancelledByProduct).totalOpenValue.minor,
        0,
      );
      return { count: issued.length, valueMinor };
    },
  };
}

/**
 * The B2B customer portal's own state (M22-FR-04, §35): which customer a login is bound to, the logins a
 * customer has, and the register of refused cross-customer reads. The account, invoices and documents the
 * portal shows are NOT here — they are projected by the credit, collections and documents adapters the staff
 * surfaces use, so a customer sees the very figures the shop sees.
 */
export function b2bPortalAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): B2BPortalDeps {
  return {
    // Round 14 (verifier G4): an OB-76 login reads the party of its approved, unrevoked invite — never a collapsed binding
    // row; any other login, the latest of its bindings and unbindings (an unbinding ends it). A login moved to another
    // customer re-points, and the old customer's list drops it.
    customerForUser: async (tenantId, userId) => {
      const governed = await governedOutsideBinding(input.store, tenantId, userId, 'b2b_customer');
      if (governed !== 'ungoverned') {
        return governed === undefined ? undefined : {
          customerId: governed.partyId, userId, grants: (governed.grants ?? []) as B2BLoginBinding['grants'],
          boundBy: governed.approvedBy ?? governed.invitedBy, at: governed.approvedAt ?? governed.invitedAt,
        };
      }
      const rows = await input.store.readStream(tenantId, forB2BPortalLogin(userId));
      const last = [...rows].reverse().find((e) => e.event.type === 'B2BLoginBound' || e.event.type === 'B2BLoginUnbound');
      return last === undefined || last.event.type === 'B2BLoginUnbound' ? undefined : payloadOf<B2BLoginBinding>(last);
    },
    recordLoginBinding: async (tenantId, binding, ref) => {
      const event = (id: string, key: string) => makeEvent({
        id, type: 'B2BLoginBound', occurredAt: binding.at,
        idempotencyKey: key, source: 'api/finance', payload: binding,
      });
      // Keyed on (user, customer, grants) so re-sending the same binding collapses, while a change of grants
      // or of customer is a new, latest-wins fact.
      // Round 14 (verifier G4): an OB-76 binding carries its invite (`ref`), so re-binding to an earlier customer is fresh.
      const digest = `${binding.userId}-${binding.customerId}-${[...binding.grants].sort().join('.')}${ref === undefined ? '' : `-${ref}`}`;
      await input.store.append(tenantId, forB2BPortalLogin(binding.userId), event(`b2b-login-${digest}`, `b2b-login-${tenantId}-${digest}`));
      await input.store.append(tenantId, forB2BPortalLogins(binding.customerId), event(`b2b-login-idx-${digest}`, `b2b-login-idx-${tenantId}-${digest}`));
    },
    // Every login ever bound to this customer, kept only while its LATEST binding still points here.
    loginsFor: async (tenantId, customerId) => {
      const ever = await allOf<B2BLoginBinding>(input.store, tenantId, forB2BPortalLogins(customerId), 'B2BLoginBound');
      const users = [...new Set(ever.map((b) => b.userId))];
      const portal = b2bPortalAdapter(input);
      const current = await Promise.all(users.map((u) => portal.customerForUser(tenantId, u)));
      return current.filter((b): b is B2BLoginBinding => b !== undefined && b.customerId === customerId);
    },
    recordAccessRefusal: async (tenantId, r) => {
      // Keyed on the FOREIGN customer asked for, so repeated distinct probes each count (a pattern) while an
      // identical retry collapses to one entry.
      await input.store.append(tenantId, forB2BPortalRefusals, makeEvent({
        id: `b2b-portal-refusal-${r.customerId}-${r.userId}-${r.action}-${r.requestedCustomerId}`,
        type: 'B2BPortalAccessRefused', occurredAt: r.at,
        idempotencyKey: `b2b-portal-refusal-${tenantId}-${r.customerId}-${r.userId}-${r.action}-${r.requestedCustomerId}`,
        source: 'api/finance', payload: r,
      }));
    },
    accessRefusals: async (tenantId) => allOf<B2BPortalRefusal>(input.store, tenantId, forB2BPortalRefusals, 'B2BPortalAccessRefused'),
  };
}

/**
 * SP-7b — the supplier ACCOUNT's registers: the invoices (SP-7a), the latest match per invoice, the purchase orders (which
 * supplier a receipt belongs to) and the goods receipts with their dispositions and excess decisions (SP-6 / SP-6b). The
 * account itself is a projection the purchase service folds from these on every read — nothing is stored twice.
 */
export function supplierAccountAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SupplierAccountDeps {
  const receipts = goodsReceiptAdapter(input).all;
  return {
    now: input.now,
    invoices: (tenantId) => liveSupplierInvoices(input.store, tenantId),
    latestMatches: async (tenantId) => {
      const byInvoice = new Map<string, StoredMatch>();
      for (const m of await allOf<StoredMatch>(input.store, tenantId, STREAM.purchase, 'InvoiceMatched')) byInvoice.set(m.invoiceId, m);
      return byInvoice;
    },
    purchaseOrders: async (tenantId) => [...(await foldPurchaseOrders(input.store, tenantId)).values()],
    receipts,
    payments: (tenantId) => allOf<SupplierPayment>(input.store, tenantId, SUPPLIER_PAYMENTS_STREAM, 'SupplierPaymentRecorded'),
    debitNoteIssues: (tenantId) => allOf<DebitNoteIssue>(input.store, tenantId, DEBIT_NOTE_ISSUES_STREAM, 'SupplierDebitNoteIssued'),
    openingBalances: async (tenantId) => openingsWithSignOff(
      await allOf<SupplierOpeningBalance>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalanceRecorded'),
      await allOf<SupplierOpeningSignOff>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalancesSignedOff'),
      await allOf<SupplierOpeningReversal>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalanceReversed'), // OB-44
    ),
    // R3 OB-196: the numbered debit notes raised at the DSD door (the check-in register, r3-ops-adapters.ts) — on the statement.
    doorDebitNotes: async (tenantId) => doorDebitNotesFrom(await allOf<DoorCheckInForAccount>(input.store, tenantId, streamName(STREAM.inventory, 'dsd-checkins'), 'DsdCheckInRecorded')),
  };
}

/**
 * GT-05 (MG-08) — the opening supplier balances register: one append-only fact per legacy bill, keyed on its opening id (two
 * writers of one id meet on the key; the one that stands is returned), and one sign-off per load, keyed on the load.
 */
export function supplierOpeningsAdapter(input: { readonly store: EventStore; readonly now: () => string }): SupplierOpeningDeps {
  return {
    now: input.now,
    record: (tenantId, supplierId) => latestSupplierRecord(input.store, tenantId, supplierId),
    openings: (tenantId) => allOf<SupplierOpeningBalance>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalanceRecorded'),
    recordOpening: async (tenantId, opening) => {
      const r = await input.store.append(tenantId, SUPPLIER_OPENINGS_STREAM, makeEvent({
        id: `supplier-opening-${opening.openingId}-${randomUUID()}`, type: 'SupplierOpeningBalanceRecorded', occurredAt: opening.recordedAt,
        idempotencyKey: `supplier-opening-${tenantId}-${opening.openingId}`, source: 'api/purchase', payload: opening,
      }));
      return r.record.event.payload as SupplierOpeningBalance;
    },
    signOffs: (tenantId) => allOf<SupplierOpeningSignOff>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalancesSignedOff'),
    reversals: (tenantId) => allOf<SupplierOpeningReversal>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalanceReversed'), // OB-44
    recordSignOff: async (tenantId, signOff) => {
      const r = await input.store.append(tenantId, SUPPLIER_OPENINGS_STREAM, makeEvent({
        id: `supplier-opening-signoff-${signOff.loadId}-${randomUUID()}`, type: 'SupplierOpeningBalancesSignedOff', occurredAt: signOff.signedAt,
        idempotencyKey: `supplier-opening-signoff-${tenantId}-${signOff.loadId}`, source: 'api/purchase', payload: signOff,
      }));
      return r.record.event.payload as SupplierOpeningSignOff;
    },
  };
}

/**
 * GT-05 (MG-08 "accounting openings"): the old system's trial balance per load and its second-person sign-off, append-only on
 * their own stream; the opening journal goes through the finance posting path's own append (one `JournalPosted`, keyed on
 * the load). The ledger read is every journal the finance stream holds.
 */
const ACCOUNT_OPENINGS_STREAM = streamName(STREAM.finance, 'account-openings');
export function accountOpeningsAdapter(input: { readonly store: EventStore; readonly now: () => string }): AccountOpeningsDeps {
  const fin = financeAdapter(input);
  return {
    now: input.now,
    records: (tenantId) => allOf<AccountOpeningsRecord>(input.store, tenantId, ACCOUNT_OPENINGS_STREAM, 'AccountOpeningsRecorded'),
    recordOpenings: async (tenantId, record) => {
      const r = await input.store.append(tenantId, ACCOUNT_OPENINGS_STREAM, makeEvent({
        id: `account-openings-${record.loadId}-${randomUUID()}`, type: 'AccountOpeningsRecorded', occurredAt: record.recordedAt,
        idempotencyKey: `account-openings-${tenantId}-${record.loadId}`, source: 'api/finance', payload: record,
      }));
      return r.record.event.payload as AccountOpeningsRecord;
    },
    signOffs: (tenantId) => allOf<AccountOpeningsSignOff>(input.store, tenantId, ACCOUNT_OPENINGS_STREAM, 'AccountOpeningsSignedOff'),
    recordSignOff: async (tenantId, signOff) => {
      const r = await input.store.append(tenantId, ACCOUNT_OPENINGS_STREAM, makeEvent({
        id: `account-openings-signoff-${signOff.loadId}-${randomUUID()}`, type: 'AccountOpeningsSignedOff', occurredAt: signOff.signedAt,
        idempotencyKey: `account-openings-signoff-${tenantId}-${signOff.loadId}`, source: 'api/finance', payload: signOff,
      }));
      return r.record.event.payload as AccountOpeningsSignOff;
    },
    journals: (tenantId) => allOf<JournalEntry>(input.store, tenantId, STREAM.finance, 'JournalPosted'),
    periodStates: fin.periodStates,
    nextOpenPeriod: fin.nextOpenPeriod,
    appendJournal: fin.appendJournal,
  };
}

/**
 * OB-44 "A" (owner, 11 Oct 2026): an opening load reversed inside the cutover window — every opening taken back out through its
 * own domain's compensating record (never a delete), each keyed on the load so a re-run lands only what is missing.
 */
const OPENING_REVERSALS_STREAM = streamName(STREAM.migration, 'opening-reversals');
const openedItemsIn = async (store: EventStore, tenantId: string, loadId: string): Promise<OpenedItems> =>
  openedItemsOf(await allOf<OpeningItem>(store, tenantId, openingItemsStream(loadId), 'OpeningItemRecorded'));
/** OB-52: the cutover GOs the gate recorded — one per cutover (keyed), the first standing. */
const CUTOVER_GO_STREAM = streamName(STREAM.migration, 'cutover-go');
const cutoverGosOf = (store: EventStore, tenantId: string): Promise<readonly CutoverGo[]> => allOf<CutoverGo>(store, tenantId, CUTOVER_GO_STREAM, 'CutoverGoRecorded');
async function recordCutoverGoIn(store: EventStore, tenantId: string, go: CutoverGo): Promise<CutoverGo> {
  // GT-05 round 12: the shop's FIRST GO stands — whatever key it was kept under (a GO from before the per-tenant key, under
  // the old per-cutover key, included). Nothing more is appended, and the gate reports exactly the GO the reversal route reads.
  const standing = (await cutoverGosOf(store, tenantId))[0];
  if (standing !== undefined) return standing;
  const res = await store.append(tenantId, CUTOVER_GO_STREAM, makeEvent({ id: `cutover-go-${go.cutoverId}-${randomUUID()}`, type: 'CutoverGoRecorded', occurredAt: go.goAt, idempotencyKey: `cutover-go-${tenantId}` /* GT-05 / OB-52: ONE GO per tenant, the real cutover's; a later GO under any id resolves to it */, source: 'api/migration', payload: go }));
  return res.record.event.payload as CutoverGo;
}
export function openingReversalAdapter(input: { readonly store: EventStore; readonly now: () => string }): OpeningReversalDeps {
  const stockOf = async (tenantId: string, loadId: string): Promise<{ opened: Movement[]; reversed: Movement[] }> => {
    const grnIds = new Set((await goodsReceiptAdapter(input).all(tenantId)).map((g) => g.grnId)
      .filter((id) => id === `opening-${loadId}` || id.startsWith(`opening-${loadId}-`)));
    const opened: Movement[] = [];
    const reversed: Movement[] = [];
    for (const e of await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })) {
      const m = payloadOf<Movement>(e);
      const grnId = m.movementId.split(':')[0]!;
      if (!grnIds.has(grnId)) continue;
      if (m.kind === 'received') opened.push(m); else if (m.kind === 'opening_reversed') reversed.push(m);
    }
    return { opened, reversed };
  };
  const supplierOpeningsOf = async (tenantId: string, loadId: string) => {
    const openings = (await allOf<SupplierOpeningBalance>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalanceRecorded')).filter((o) => o.loadId === loadId);
    const reversals = (await allOf<SupplierOpeningReversal>(input.store, tenantId, SUPPLIER_OPENINGS_STREAM, 'SupplierOpeningBalanceReversed')).filter((r) => r.loadId === loadId);
    return { openings, reversals };
  };
  const journalsOf = async (tenantId: string, loadId: string) => {
    const all = await allOf<JournalEntry>(input.store, tenantId, STREAM.finance, 'JournalPosted');
    return { opening: all.find((j) => j.entryId === openingEntryId(loadId)), reversal: all.find((j) => j.entryId === openingReversalEntryId(loadId)) };
  };
  const svId = (loadId: string, instrumentId: string): string => `${loadId}-reversal-${instrumentId}`;
  const ptsId = (loadId: string, customerId: string): string => `${loadId}-opening-${customerId}-reversal`;
  const rcptId = (loadId: string, invoiceId: string): string => `opening-reversal-${loadId}-${invoiceId}`;
  const sv = storedValueAdapter(input);
  const customers = customerAdapter(input);
  const collections = b2bCollectionsAdapter(input);
  const fin = financeAdapter(input);
  const net = (j: JournalEntry | undefined): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of j?.lines ?? []) m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + l.debitMinor - l.creditMinor);
    return m;
  };
  return {
    now: input.now,
    // OB-52: the window is the recorded GO's (round-6 `CutoverWindowRecorded` typed windows are kept but no longer read).
    gos: (tenantId) => cutoverGosOf(input.store, tenantId),
    openedItems: (tenantId, loadId) => openedItemsIn(input.store, tenantId, loadId),
    requests: (tenantId) => allOf<OpeningReversalRequest>(input.store, tenantId, OPENING_REVERSALS_STREAM, 'OpeningReversalRequested'),
    recordRequest: async (tenantId, r) => {
      const res = await input.store.append(tenantId, OPENING_REVERSALS_STREAM, makeEvent({ id: `opening-reversal-${r.loadId}-${randomUUID()}`, type: 'OpeningReversalRequested', occurredAt: r.requestedAt, idempotencyKey: `opening-reversal-${tenantId}-${r.loadId}`, source: 'api/migration', payload: r }));
      return res.record.event.payload as OpeningReversalRequest;
    },
    approvals: (tenantId) => allOf<OpeningReversalApproval>(input.store, tenantId, OPENING_REVERSALS_STREAM, 'OpeningReversalApproved'),
    recordApproval: async (tenantId, a) => {
      const res = await input.store.append(tenantId, OPENING_REVERSALS_STREAM, makeEvent({ id: `opening-reversal-approval-${a.loadId}-${randomUUID()}`, type: 'OpeningReversalApproved', occurredAt: a.approvedAt, idempotencyKey: `opening-reversal-approval-${tenantId}-${a.loadId}`, source: 'api/migration', payload: a }));
      return res.record.event.payload as OpeningReversalApproval;
    },

    problems: async (tenantId, asked) => {
      // Round 7: the items are ALWAYS the load's own register's — whatever the request record holds.
      const r = { ...asked, ...(await openedItemsIn(input.store, tenantId, asked.loadId)) };
      const p: string[] = [];
      for (const v of r.storedValue) {
        const inst = await sv.instrument(tenantId, v.instrumentId);
        if (inst === undefined) { p.push(`gift card / credit ${v.instrumentId} does not exist`); continue; }
        const ms = await sv.movements(tenantId, v.instrumentId);
        const done = ms.some((m) => m.movementId === svId(r.loadId, v.instrumentId));
        const issued = ms.filter((m) => m.kind === 'issue').reduce((s, m) => s + m.deltaMinor, 0);
        const balance = ms.reduce((s, m) => s + m.deltaMinor, 0);
        if (issued !== v.balanceMinor) p.push(`${v.instrumentId} was opened at ${issued} paise, not ${v.balanceMinor}`);
        else if (!done && balance !== v.balanceMinor) p.push(`${v.instrumentId} has moved since it opened (balance ${balance} of ${v.balanceMinor}) — a spent card is not undone by a reversal`);
      }
      for (const rc of r.receivables) {
        const inv = (await collections.invoices(tenantId, rc.customerId)).find((i) => i.invoiceId === rc.invoiceId);
        if (inv === undefined) { p.push(`invoice ${rc.customerId}/${rc.invoiceId} does not exist`); continue; }
        const payments = await allOf<RecordedPayment>(input.store, tenantId, forB2BCustomer(rc.customerId), 'B2BPaymentAllocated');
        const done = payments.some((x) => x.receiptId === rcptId(r.loadId, rc.invoiceId));
        if (inv.grossMinor !== rc.outstandingMinor) p.push(`invoice ${rc.invoiceId} was opened at ${inv.grossMinor} paise, not ${rc.outstandingMinor}`);
        else if (!done && inv.settledMinor !== 0) p.push(`invoice ${rc.invoiceId} is already part-paid (${inv.settledMinor} paise) — a collected invoice is not undone by a reversal`);
      }
      for (const c of r.pointsCustomers) {
        const ms = await customers.pointsMovements(tenantId, c);
        const opening = ms.find((m) => m.movementId === `${r.loadId}-opening-${c}`);
        if (opening === undefined) { p.push(`no opening points of customer ${c} under load ${r.loadId}`); continue; }
        const done = ms.some((m) => m.movementId === ptsId(r.loadId, c));
        const balance = ms.reduce((s, m) => s + m.delta, 0);
        if (!done && balance < opening.delta) p.push(`customer ${c} has spent opening points (balance ${balance} of ${opening.delta})`);
      }
      const stock = await stockOf(tenantId, r.loadId);
      const sup = await supplierOpeningsOf(tenantId, r.loadId);
      const j = await journalsOf(tenantId, r.loadId);
      if (stock.opened.length === 0 && sup.openings.length === 0 && j.opening === undefined && r.storedValue.length === 0 && r.receivables.length === 0 && r.pointsCustomers.length === 0) {
        p.push(`nothing was opened under load ${r.loadId}`);
      }
      return p;
    },

    execute: async (tenantId, asked, a) => {
      const r = { ...asked, ...(await openedItemsIn(input.store, tenantId, asked.loadId)) };
      const at = a.approvedAt;
      const why = `opening load ${r.loadId} reversed in cutover ${r.cutoverId}: ${r.reason} (requested by ${r.requestedBy}, approved by ${a.approvedBy})`;
      // Stock: every opening receipt movement out again, at its own cost.
      const stock = await stockOf(tenantId, r.loadId);
      const done = new Set(stock.reversed.map((m) => m.movementId));
      const batch: Parameters<EventStore['appendBatch']>[1][number][] = [];
      for (const m of stock.opened) {
        const movementId = `${m.movementId}:reversed`;
        if (done.has(movementId)) continue;
        const back: Movement = {
          movementId, productId: m.productId, locationId: m.locationId, kind: 'opening_reversed', quantityMinor: m.quantityMinor, uom: m.uom,
          occurredAt: at, reason: why, approvedBy: a.approvedBy, enteredBy: r.requestedBy,
          ...(m.batchId === undefined ? {} : { batchId: m.batchId }), ...(m.expiry === undefined ? {} : { expiry: m.expiry }),
          ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }), ...(m.unitCostPer === undefined ? {} : { unitCostPer: m.unitCostPer }),
        };
        batch.push({ stream: STREAM.inventory, event: makeEvent({ id: `mv-${movementId}`, type: 'InventoryMoved', occurredAt: at, idempotencyKey: `mv-${tenantId}-${movementId}`, source: 'api/migration', payload: back }) });
      }
      // Supplier bills: each opening of the load reversed, once.
      const sup = await supplierOpeningsOf(tenantId, r.loadId);
      const supDone = new Set(sup.reversals.map((x) => x.openingId));
      for (const o of sup.openings) {
        if (supDone.has(o.openingId)) continue;
        const rev: SupplierOpeningReversal = { openingId: o.openingId, loadId: r.loadId, reversalId: `${r.loadId}-${o.openingId}`, requestedBy: r.requestedBy, approvedBy: a.approvedBy, at };
        batch.push({ stream: SUPPLIER_OPENINGS_STREAM, event: makeEvent({ id: `supplier-opening-reversal-${o.openingId}`, type: 'SupplierOpeningBalanceReversed', occurredAt: at, idempotencyKey: `supplier-opening-reversal-${tenantId}-${o.openingId}`, source: 'api/migration', payload: rev }) });
      }
      if (batch.length > 0) await input.store.appendBatch(tenantId, batch);
      // Stored value: the opening balance adjusted back off each instrument.
      for (const v of r.storedValue) {
        const ms = await sv.movements(tenantId, v.instrumentId);
        if (ms.some((m) => m.movementId === svId(r.loadId, v.instrumentId))) continue;
        await sv.recordMovement(tenantId, v.instrumentId, { movementId: svId(r.loadId, v.instrumentId), instrumentId: v.instrumentId, kind: 'adjust', deltaMinor: -v.balanceMinor, at, channel: 'store', reason: why },
          await sv.instrumentVersion!(tenantId, v.instrumentId));
      }
      // Receivables: a credit allocation settles each opening invoice — no money received, nothing posts as a receipt.
      for (const rc of r.receivables) {
        const inv = (await collections.invoices(tenantId, rc.customerId)).find((i) => i.invoiceId === rc.invoiceId);
        await collections.recordPayment(tenantId, rc.customerId, {
          receiptId: rcptId(r.loadId, rc.invoiceId), receivedMinor: 0,
          allocations: [{ invoiceId: rc.invoiceId, number: inv?.number ?? rc.invoiceId, appliedMinor: rc.outstandingMinor, stillOpenMinor: 0 }],
          creditFor: 'opening_reversal', reason: why,
        } as RecordedPayment);
      }
      // Loyalty: the opening points taken back by a reversal movement.
      for (const c of r.pointsCustomers) {
        const ms = await customers.pointsMovements(tenantId, c);
        const opening = ms.find((m) => m.movementId === `${r.loadId}-opening-${c}`);
        if (opening === undefined || ms.some((m) => m.movementId === ptsId(r.loadId, c))) continue;
        await customers.recordPointsMovement(tenantId, c, { movementId: ptsId(r.loadId, c), customerId: c, delta: -opening.delta, reason: 'reversal', sourceRef: why, at },
          await input.store.guardVersion(tenantId, `points:${c}`));
      }
      // The ledger: the opening journal's mirror image, its own entry, through the posting rules (a closed month → the next open one).
      const j = await journalsOf(tenantId, r.loadId);
      if (j.opening !== undefined && j.reversal === undefined) {
        const entry: JournalEntry = {
          entryId: openingReversalEntryId(r.loadId), period: j.opening.period, documentDate: at.slice(0, 10), narrative: why,
          lines: j.opening.lines.map((l) => ({ accountCode: l.accountCode, debitMinor: l.creditMinor, creditMinor: l.debitMinor })), postedBy: a.approvedBy,
        };
        const states = await fin.periodStates(tenantId);
        const next = await fin.nextOpenPeriod(tenantId);
        const verdict = postJournal({ entry, periodStates: states, nextOpenPeriod: next });
        await fin.appendJournal(tenantId, verdict.ok ? entry : { ...entry, period: next });
      }
    },

    position: async (tenantId, asked) => {
      const r = { ...asked, ...(await openedItemsIn(input.store, tenantId, asked.loadId)) };
      const out: ReversalDomainLine[] = [];
      const stock = await stockOf(tenantId, r.loadId);
      const qty = new Map<string, { opened: number; reversed: number }>();
      let openedValue = 0;
      let reversedValue = 0;
      for (const m of stock.opened) {
        const k = `${m.productId}@${m.locationId}`;
        qty.set(k, { opened: (qty.get(k)?.opened ?? 0) + m.quantityMinor, reversed: qty.get(k)?.reversed ?? 0 });
        if (m.unitCostMinor !== undefined) openedValue += valueAtCost(m.quantityMinor, m.uom ?? 'ea', { minor: m.unitCostMinor, ...(m.unitCostPer === undefined ? {} : { per: m.unitCostPer }) });
      }
      for (const m of stock.reversed) {
        const k = `${m.productId}@${m.locationId}`;
        qty.set(k, { opened: qty.get(k)?.opened ?? 0, reversed: (qty.get(k)?.reversed ?? 0) + m.quantityMinor });
        if (m.unitCostMinor !== undefined) reversedValue += valueAtCost(m.quantityMinor, m.uom ?? 'ea', { minor: m.unitCostMinor, ...(m.unitCostPer === undefined ? {} : { per: m.unitCostPer }) });
      }
      for (const [k, v] of [...qty].sort(([a], [b]) => (a < b ? -1 : 1))) out.push({ domain: 'stock_quantity', key: k, openedMinor: v.opened, reversedMinor: v.reversed, netMinor: v.opened - v.reversed });
      if (stock.opened.length > 0) out.push({ domain: 'stock_value', key: 'opening receipts', openedMinor: openedValue, reversedMinor: reversedValue, netMinor: openedValue - reversedValue });
      for (const v of r.storedValue) {
        const ms = await sv.movements(tenantId, v.instrumentId);
        const opened = ms.filter((m) => m.kind === 'issue').reduce((s, m) => s + m.deltaMinor, 0);
        const reversed = -ms.filter((m) => m.movementId === svId(r.loadId, v.instrumentId)).reduce((s, m) => s + m.deltaMinor, 0);
        out.push({ domain: 'stored_value', key: v.instrumentId, openedMinor: opened, reversedMinor: reversed, netMinor: opened - reversed });
      }
      for (const rc of r.receivables) {
        const inv = (await collections.invoices(tenantId, rc.customerId)).find((i) => i.invoiceId === rc.invoiceId);
        const payments = await allOf<RecordedPayment>(input.store, tenantId, forB2BCustomer(rc.customerId), 'B2BPaymentAllocated');
        const reversed = payments.filter((x) => x.receiptId === rcptId(r.loadId, rc.invoiceId)).flatMap((x) => x.allocations).reduce((s, x) => s + x.appliedMinor, 0);
        out.push({ domain: 'receivables', key: `${rc.customerId}/${rc.invoiceId}`, openedMinor: inv?.grossMinor ?? 0, reversedMinor: reversed, netMinor: (inv?.grossMinor ?? 0) - reversed });
      }
      for (const c of r.pointsCustomers) {
        const ms = await customers.pointsMovements(tenantId, c);
        const opened = ms.find((m) => m.movementId === `${r.loadId}-opening-${c}`)?.delta ?? 0;
        const reversed = -(ms.find((m) => m.movementId === ptsId(r.loadId, c))?.delta ?? 0);
        out.push({ domain: 'points', key: c, openedMinor: opened, reversedMinor: reversed, netMinor: opened - reversed });
      }
      const sup = await supplierOpeningsOf(tenantId, r.loadId);
      const revd = new Set(sup.reversals.map((x) => x.openingId));
      for (const o of sup.openings) out.push({ domain: 'supplier_openings', key: `${o.supplierId}/${o.openingId}`, openedMinor: o.amountMinor, reversedMinor: revd.has(o.openingId) ? o.amountMinor : 0, netMinor: revd.has(o.openingId) ? 0 : o.amountMinor });
      const j = await journalsOf(tenantId, r.loadId);
      const opened = net(j.opening);
      const reversed = net(j.reversal);
      for (const code of [...new Set([...opened.keys(), ...reversed.keys()])].sort()) {
        const o = opened.get(code) ?? 0;
        const back = -(reversed.get(code) ?? 0);
        out.push({ domain: 'ledger', key: code, openedMinor: o, reversedMinor: back, netMinor: o - back });
      }
      return out;
    },
  };
}

/** The supplier master's latest version per supplier — append-only versions, the highest applies. */
async function foldSupplierRecords(store: EventStore, tenantId: string): Promise<ReadonlyMap<string, SupplierRecord>> {
  const byId = new Map<string, SupplierRecord>();
  for (const r of await allOf<SupplierRecord>(store, tenantId, SUPPLIERS_STREAM, 'SupplierRecorded')) {
    const cur = byId.get(r.supplierId);
    if (cur === undefined || r.version >= cur.version) byId.set(r.supplierId, r);
  }
  return byId;
}
const latestSupplierRecord = async (store: EventStore, tenantId: string, supplierId: string): Promise<SupplierRecord | undefined> =>
  (await foldSupplierRecords(store, tenantId)).get(supplierId);

/** Each supplier's CURRENT verified bank account, folded from the append-only bank-change ledger (the last change wins). */
async function latestBankState(store: EventStore, tenantId: string, supplierId: string): Promise<SupplierBankState | undefined> {
  const changes = (await allOf<BankChangeRequest>(store, tenantId, STREAM.purchase, 'SupplierBankChanged')).filter((c) => c.supplierId === supplierId);
  const last = changes.at(-1);
  return last === undefined ? undefined : { accountRef: last.newAccount, requestedBy: last.requestedBy, verifiedBy: last.approvedBy ?? '', changedAt: last.requestedAt };
}

/**
 * SP-7c — the supplier MASTER (M06-FR-01) over the account's registers: the versioned record, the block state, the verified
 * bank account (the bank-change ledger), the duplicate-bank holders (the same fold the fraud-signals report reads), the
 * payments and the issued debit notes. The debit-note number comes from the tenant's own series.
 */
export function supplierMasterAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly numberSeries?: NumberSeriesStore;
}): Omit<SupplierMasterDeps, 'recordAudit'> {
  const numberSeries = input.numberSeries ?? new InMemoryNumberSeriesStore();
  return {
    ...supplierAccountAdapter(input),
    record: (tenantId, supplierId) => latestSupplierRecord(input.store, tenantId, supplierId),
    records: async (tenantId) => [...(await foldSupplierRecords(input.store, tenantId)).values()],
    recordSupplier: async (tenantId, record) => {
      await input.store.append(tenantId, SUPPLIERS_STREAM, makeEvent({
        id: `supplier-${record.supplierId}-v${record.version}`,
        type: 'SupplierRecorded',
        occurredAt: record.updatedAt,
        // One event per version: a retried write of the same version collapses; the next version is a new fact.
        idempotencyKey: `supplier-${tenantId}-${record.supplierId}-v${record.version}`,
        source: 'api/purchase',
        payload: record,
      }));
    },
    supplierBlocked: async (tenantId, supplierId) => (await latestBlock(input.store, tenantId, supplierId))?.blocked ?? false,
    bankState: (tenantId, supplierId) => latestBankState(input.store, tenantId, supplierId),
    bankHolders: async (tenantId) => {
      const changes = await allOf<BankChangeRequest>(input.store, tenantId, STREAM.purchase, 'SupplierBankChanged');
      const currentAccount = new Map<string, string>();
      for (const c of changes) currentAccount.set(c.supplierId, c.newAccount);
      return [...currentAccount.entries()].map(([holderId, accountRef]) => ({ holderId, holderType: 'supplier' as const, accountRef }));
    },
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    recordPayment: async (tenantId, payment) => {
      await input.store.append(tenantId, SUPPLIER_PAYMENTS_STREAM, makeEvent({
        id: `supplier-payment-${payment.paymentId}`,
        type: 'SupplierPaymentRecorded',
        occurredAt: payment.recordedAt,
        // One payment, one record — a retry never pays twice.
        idempotencyKey: `supplier-payment-${tenantId}-${payment.paymentId}`,
        source: 'api/purchase',
        payload: payment,
      }));
    },
    allocateNumber: (tenantId, docType) => numberSeries.allocate(tenantId, docType),
    recordDebitNoteIssue: async (tenantId, issue) => {
      await input.store.append(tenantId, DEBIT_NOTE_ISSUES_STREAM, makeEvent({
        id: `dn-issue-${issue.debitNoteRef}`,
        type: 'SupplierDebitNoteIssued',
        occurredAt: issue.issuedAt,
        idempotencyKey: `dn-issue-${tenantId}-${issue.supplierId}-${issue.debitNoteRef}`,
        source: 'api/purchase',
        payload: issue,
      }));
    },
  };
}

/**
 * SP-7b (M23-FR-01) — payables: the supplier accounts (projected from the purchase registers above) post through the
 * accountant's mapping via the same `appendJournal` every other voucher uses, so the period fold, the posters list and
 * the close gate see them as journals like any other. Exceptions are append-only finance-stream facts (hard rule #6).
 */
/**
 * The inventory-loss journal's reads (Batch 3 · Batch 2's `ShortfallLoss`): every resolved floor-indent and transfer
 * shortfall's valued loss from the warehouse streams, and the stock-loss vouchers already posted.
 */
export function stockLossAdapter(input: { readonly store: EventStore; readonly now: () => string }): StockLossDeps {
  const fin = financeAdapter(input);
  return {
    periodStates: fin.periodStates, nextOpenPeriod: fin.nextOpenPeriod, appendJournal: fin.appendJournal, now: input.now,
    postingMap: (tenantId) => latest<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined'),
    losses: async (tenantId) => {
      const out: ShortfallLoss[] = [];
      for (const [stream, type] of [[streamName(STREAM.warehouse, 'indents'), 'FloorIndentShortfallResolved'], [streamName(STREAM.warehouse, 'transfers'), 'TransferShortfallResolved']] as const) {
        for (const e of await input.store.readStream(tenantId, stream, { type })) {
          const loss = (e.event.payload as { loss?: ShortfallLoss }).loss;
          if (loss !== undefined) out.push(loss);
        }
      }
      return out;
    },
    stockLossJournals: async (tenantId) =>
      (await allOf<JournalEntry | StockLossJournal>(input.store, tenantId, STREAM.finance, 'JournalPosted'))
        .filter((j): j is StockLossJournal => 'stockLoss' in j),
    // WF-08 (round 8): every count correction that posted to the stock ledger (`count:<countId>`), with its value and cause.
  };
}

export function payablesAdapter(input: { readonly store: EventStore; readonly now: () => string }): PayablesDeps {
  const fin = financeAdapter(input);
  const registers = supplierAccountAdapter(input);
  return {
    periodStates: fin.periodStates,
    nextOpenPeriod: fin.nextOpenPeriod,
    appendJournal: fin.appendJournal,
    now: input.now,
    postingMap: (tenantId) => latest<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined'),
    supplierAccounts: async (tenantId) => {
      const [invoices, matches, orders, receipts, payments, debitNoteIssues, openings] = await Promise.all([
        registers.invoices(tenantId), registers.latestMatches(tenantId), registers.purchaseOrders(tenantId), registers.receipts(tenantId),
        registers.payments(tenantId), registers.debitNoteIssues(tenantId), registers.openingBalances!(tenantId),
      ]);
      return foldAllSupplierAccounts({ invoices, matchOf: (id) => matches.get(id), orders, receipts, payments, debitNoteIssues, openings, asAt: input.now() }).accounts;
    },
    payablesJournals: async (tenantId) =>
      (await allOf<JournalEntry | PayablesJournal>(input.store, tenantId, STREAM.finance, 'JournalPosted'))
        .filter((j): j is PayablesJournal => 'payables' in j),
    recordException: async (tenantId, e) => {
      await input.store.append(tenantId, STREAM.finance, makeEvent({
        id: `payables-exc-${e.exceptionId}`,
        type: 'PayablesExceptionRaised',
        occurredAt: e.raisedAt,
        idempotencyKey: `payables-exc-${tenantId}-${e.exceptionId}`,
        source: 'api/finance',
        payload: e,
      }));
    },
    exceptions: (tenantId) => allOf<PayablesExceptionRecord>(input.store, tenantId, STREAM.finance, 'PayablesExceptionRaised'),
  };
}

export function supplierPortalAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SupplierPortalDeps {
  const registers = supplierAccountAdapter(input);
  /** The supplier account (SP-7b) as statement lines for the partner whose id is the supplier's — nothing when it names no supplier. */
  const accountStatementLines = async (tenantId: string, partnerId: string): Promise<readonly StatementLine[]> => {
    const [invoices, matches, orders, receipts, payments, debitNoteIssues, openings] = await Promise.all([
      registers.invoices(tenantId), registers.latestMatches(tenantId), registers.purchaseOrders(tenantId), registers.receipts(tenantId),
      registers.payments(tenantId), registers.debitNoteIssues(tenantId), registers.openingBalances!(tenantId),
    ]);
    const a = foldSupplierAccount({ supplierId: partnerId, invoices, matchOf: (id) => matches.get(id), orders, receipts, payments, debitNoteIssues, openings, asAt: input.now() });
    const lines: StatementLine[] = [];
    for (const i of a.invoices) {
      if (!i.matched) continue;
      const date = (i.matchedAt ?? i.capturedAt).slice(0, 10);
      if (i.payableMinor > 0) lines.push({ partnerId, tenantId, documentRef: `account:invoice:${i.invoiceId}`, kind: 'invoice', date, amountMinor: i.payableMinor, status: 'open' });
      if (i.withheldMinor > 0) lines.push({ partnerId, tenantId, documentRef: `account:invoice:${i.invoiceId}:withheld`, kind: 'invoice', date, amountMinor: i.withheldMinor, status: 'disputed' });
    }
    for (const d of a.debitNotes) lines.push({ partnerId, tenantId, documentRef: `account:debit-note:${d.debitNoteRef}`, kind: 'credit_note', date: d.decidedAt.slice(0, 10), amountMinor: -d.valueMinor, status: 'open' });
    for (const p of a.payments) lines.push({ partnerId, tenantId, documentRef: `account:payment:${p.paymentId}`, kind: 'payment', date: p.paidOn, amountMinor: -p.amountMinor, status: 'settled' });
    return lines;
  };
  return {
    now: input.now,

    // The latest configuration applies — grants and compliance can change, folded to their newest set.
    partner: async (tenantId, partnerId) =>
      latest<PartnerConfig>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierPartnerConfigured'),

    // Which partner this login is bound to (M24-FR-01) — read from the per-user login index the config
    // write maintains below. Latest binding wins, so a login reassigned to another partner re-points.
    // Round 14 (verifier G4): an OB-76 login reads the partner of its approved, unrevoked invite; any other login, the
    // latest of its bindings and unbindings.
    partnerForUser: async (tenantId, userId) => {
      const governed = await governedOutsideBinding(input.store, tenantId, userId, 'supplier');
      if (governed !== 'ungoverned') return governed?.partyId;
      const rows = await input.store.readStream(tenantId, forPortalLogin(userId));
      const last = [...rows].reverse().find((e) => e.event.type === 'SupplierLoginBound' || e.event.type === 'SupplierLoginUnbound');
      return last === undefined || last.event.type === 'SupplierLoginUnbound' ? undefined : payloadOf<{ partnerId: string }>(last).partnerId;
    },

    submissions: async (tenantId, partnerId) =>
      allOf<SubmissionRecord>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierSubmissionReceived'),

    // A statement line dedupes on its own document ref, so a status change (open → disputed → settled)
    // supersedes rather than recording the same invoice twice.
    //
    // SP-7c (P-02, one commerce truth): the lines head office's OWN registers say — the supplier account of SP-7b — ride the
    // statement beside any manually recorded line, when the portal partner id IS the supplier id. Our debit note is the
    // supplier's credit note (it reduces what they are owed), a payment reduces it, the withheld figure is the disputed one.
    statementLines: async (tenantId, partnerId) => {
      const all = await allOf<StatementLine>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierStatementLineRecorded');
      const byRef = new Map<string, StatementLine>();
      for (const l of all) byRef.set(l.documentRef, l);
      for (const l of await accountStatementLines(tenantId, partnerId)) byRef.set(l.documentRef, l);
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
      const partnerKey = `portal-partner-${tenantId}-${partnerId}-${config.grants.join('.')}-${config.requiredDocuments.join('.')}-${docsDigest}-${[...config.logins].sort().join('.')}`;
      const v = (c: typeof config): string => `${c.grants.join('.')}-${c.requiredDocuments.join('.')}-${c.documents.map((d) => `${d.documentId}:${d.kind}:${d.validUntil}:${d.verifiedBy ?? 'unv'}`).sort().join(',')}-${[...c.logins].sort().join('.')}`;
      // The id follows the key: a changed config (a verification, a new document) is a new event with its own id — it
      // used to reuse the grants-only id, which the ledger's unique event id refuses (a 500 on PostgreSQL). And the key
      // names the config it supersedes, so a change BACK to an earlier config is in force (hard rule #10, verifier r18).
      await appendSetting(input.store, tenantId, forPortalPartner(partnerId), {
        type: 'SupplierPartnerConfigured', idPrefix: `portal-partner-${partnerId}`, valueKey: partnerKey,
        occurredAt: input.now(), source: 'api/purchase', payload: config,
        sameValue: (p) => v(p as typeof config) === v(config),
      });
      // Maintain the per-user login index (M24-FR-01) so a supplier-facing read resolves its partner id
      // from the session. One binding event per login, keyed by (user, partner) so a re-config with the
      // same login collapses but a reassignment to another partner is a new, latest-wins fact.
      for (const userId of config.logins) {
        await input.store.append(tenantId, forPortalLogin(userId), makeEvent({
          id: `portal-login-${userId}-${partnerId}`,
          type: 'SupplierLoginBound',
          occurredAt: input.now(),
          idempotencyKey: `portal-login-${tenantId}-${userId}-${partnerId}`,
          source: 'api/purchase',
          payload: { userId, partnerId },
        }));
      }
    },

    // SF-09: the order a supplier's document names, from head office's order register — whose it is is never the body's.
    orderSupplier: async (tenantId, poId) => (await foldPurchaseOrders(input.store, tenantId)).get(poId)?.supplierId,
    reviews: (tenantId, partnerId) => allOf<SubmissionReview>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierSubmissionReviewed'),
    recordReview: async (tenantId, review) => {
      await input.store.append(tenantId, forPortalPartner(review.partnerId), makeEvent({
        id: `portal-review-${review.submissionId}`, type: 'SupplierSubmissionReviewed', occurredAt: review.reviewedAt,
        // Once per submission: a second decision is refused by the route; a retried one collapses here.
        idempotencyKey: `portal-review-${tenantId}-${review.partnerId}-${review.submissionId}`, source: 'api/purchase', payload: review,
      }));
    },
    // SF-09: an accepted invoice goes onto the SAME supplier-invoice register the screen and the API capture into.
    captureInvoice: (tenantId, i) => capturePortalInvoice(purchaseAdapter(input), tenantId, i),
    recordAsn: async (tenantId, asn, at) => {
      await input.store.append(tenantId, ASN_REGISTER_STREAM, makeEvent({
        id: `asn-${asn.asnId}`, type: 'AsnAccepted', occurredAt: at, idempotencyKey: `asn-${tenantId}-${asn.asnId}`, source: 'api/purchase', payload: asn as unknown as Record<string, unknown>,
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
      // Keyed on the value AND the opening it supersedes (hard rule #10, verifier r18): a change back is in force.
      await appendSetting(input.store, tenantId, forPortalPartner(partnerId), {
        type: 'SupplierStatementOpeningSet', idPrefix: `portal-opening-${partnerId}`, valueKey: `portal-opening-${tenantId}-${partnerId}-${openingMinor}`,
        occurredAt: input.now(), source: 'api/purchase', payload: { openingMinor },
        sameValue: (p) => (p as { openingMinor: number }).openingMinor === openingMinor,
      });
    },

    // Append-only partner-action audit (hard rule #6). Keyed on the action so a re-synced attempt is one
    // entry; a genuine new attempt (a different submission id) is a new fact — which is what makes a
    // pattern of refusals visible rather than collapsing into one.
    recordAudit: async (tenantId, entry, key) => {
      await input.store.append(tenantId, PORTAL_AUDIT_STREAM, makeEvent({
        id: `portal-audit-${key}`,
        type: 'PortalActionAudited',
        occurredAt: entry.at,
        idempotencyKey: `portal-audit-${tenantId}-${key}`,
        source: 'api/purchase',
        payload: entry,
      }));
    },

    auditEntries: async (tenantId) =>
      allOf<PartnerAuditEntry>(input.store, tenantId, PORTAL_AUDIT_STREAM, 'PortalActionAudited'),
  };
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
  // Period lifecycle: close and reopen are both append-only facts. Each carries a transition `seq` so the
  // LATEST per period wins regardless of fetch order — a reopened period is open again and re-closable
  // (M23-FR-04). Legacy `PeriodClosed` events carry no seq and read as seq 0, so a period closed before
  // reopen existed still folds to closed.
  const lifecycle = async (tenantId: string) => {
    const closes = (await allOf<{ readonly period: string; readonly seq?: number }>(input.store, tenantId, STREAM.periods, 'PeriodClosed'))
      .map((e) => ({ period: e.period, seq: e.seq ?? 0, state: 'closed' as PeriodState }));
    const reopens = (await allOf<{ readonly period: string; readonly seq?: number }>(input.store, tenantId, STREAM.periods, 'PeriodReopened'))
      .map((e) => ({ period: e.period, seq: e.seq ?? 0, state: 'open' as PeriodState }));
    return [...closes, ...reopens];
  };
  const latestByPeriod = async (tenantId: string): Promise<ReadonlyMap<string, PeriodState>> => {
    const seqByPeriod = new Map<string, number>();
    const stateByPeriod = new Map<string, PeriodState>();
    for (const e of await lifecycle(tenantId)) {
      const seen = seqByPeriod.get(e.period);
      if (seen === undefined || e.seq > seen) { seqByPeriod.set(e.period, e.seq); stateByPeriod.set(e.period, e.state); }
    }
    return stateByPeriod;
  };
  const closed = async (tenantId: string): Promise<ReadonlySet<string>> =>
    new Set([...(await latestByPeriod(tenantId))].filter(([, s]) => s === 'closed').map(([p]) => p));
  const transitionsFor = async (tenantId: string, period: string): Promise<number> =>
    (await lifecycle(tenantId)).filter((e) => e.period === period).length;

  return {
    now: input.now,

    /** State is the LATEST lifecycle fact per period (close/reopen), not a stored flag — so a period is
     *  never open and closed at once, and a reopened one is open again. A period seen only in journals
     *  (never closed) is open. */
    periodStates: async (tenantId) => {
      const latest = await latestByPeriod(tenantId);
      const seen = new Set<string>([...latest.keys(), ...(await journals(tenantId)).map((j) => j.period)]);
      return new Map([...seen].sort().map((p) => [p, latest.get(p) ?? 'open'] as const)) as ReadonlyMap<string, PeriodState>;
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
     * No control total can be built from this system ALONE, and it does not try: every check pairs a figure from the books
     * with the same figure from OUTSIDE — the provider's settlement files and the bank's statements, imported with their
     * provenance (Wave 5 · PF-12, `services/finance/src/independent-evidence.ts`). A month with nothing imported to compare
     * still has no check, does not close, and the refusal says why. `closePeriod` still refuses a pair that shares a
     * derivation by name.
     */
    controlTotals: async (tenantId, period) => (await independentEvidenceAdapter(input).evidenceFor(tenantId, period)).checks,

    /** Who posted into the month — the separation-of-duties check reads this, so it must be real. */
    postersIn: async (tenantId, period) => [...new Set(
      (await journals(tenantId)).filter((j) => j.period === period).map((j) => j.postedBy),
    )].sort(),

    markClosed: async (tenantId, period, signedBy) => {
      const seq = await transitionsFor(tenantId, period);
      await input.store.append(tenantId, STREAM.periods, makeEvent({
        id: `close-${period}-${seq}`,
        type: 'PeriodClosed',
        occurredAt: input.now(),
        // Keyed by the transition number so a re-close AFTER a reopen is a new fact, not a collapsed one.
        idempotencyKey: `close-${tenantId}-${period}-${seq}`,
        source: 'api/finance',
        payload: { period, signedBy, closedAt: input.now(), seq },
      }));
    },

    markReopened: async (tenantId, period, reopen) => {
      const seq = await transitionsFor(tenantId, period);
      await input.store.append(tenantId, STREAM.periods, makeEvent({
        id: `reopen-${period}-${seq}`,
        type: 'PeriodReopened',
        occurredAt: input.now(),
        idempotencyKey: `reopen-${tenantId}-${period}-${seq}`,
        source: 'api/finance',
        payload: { period, ...reopen, reopenedAt: input.now(), seq },
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

/** The tenant's segmentation policy is ONE fact per tenant (its boundaries), latest applies (M16-FR-02). */
const SEGMENT_POLICY_STREAM = streamName(STREAM.customer, 'segment-policy');
/** Customer behavioural facts are TENANT-WIDE (one stream each) so the stateful segmentation folds the
 *  whole base in one pass — the customer's orders + complaints the buckets read (M16-FR-02). */
const ORDER_FACTS_STREAM = streamName(STREAM.customer, 'order-facts');
const COMPLAINT_FACTS_STREAM = streamName(STREAM.customer, 'complaint-facts');

/**
 * The customer segmentation data store (M16-FR-02): the per-tenant POLICY (boundaries for what counts as
 * new/loyal/lapsing), the customer behavioural FACTS (orders + complaints) the stateful buckets read, and
 * the per-customer CONSENT ledger (the SAME record the send-gate reads — P-02). All event-sourced; facts
 * fold latest-per-id so a correction supersedes. A shop sets its policy once and the audience/ranking
 * reads run over its own stored data, rather than facts re-supplied on every call.
 */
export function segmentDataAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<SegmentDeps, 'now'> {
  const latestPerId = <T>(rows: readonly T[], id: (t: T) => string): readonly T[] => {
    const by = new Map<string, T>();
    for (const r of rows) by.set(id(r), r); // allOf is oldest-first, so the last write wins
    return [...by.values()];
  };
  return {
    policy: async (tenantId) =>
      latest<SegmentPolicy>(input.store, tenantId, SEGMENT_POLICY_STREAM, 'SegmentPolicySet'),
    recordPolicy: async (tenantId, policy) => {
      const v = (p: SegmentPolicy): string => [p.newBelowOrders, p.loyalAtOrders, p.lapsingAfterDays, p.lapsedAfterDays, p.minimumHistory].join('.');
      // Keyed on the values AND the policy they supersede (hard rule #10, verifier r18): re-sending the policy in force
      // collapses; any change — including back to an earlier policy — is a new, latest fact (the fixed id used to refuse it).
      await appendSetting(input.store, tenantId, SEGMENT_POLICY_STREAM, {
        type: 'SegmentPolicySet', idPrefix: 'segment-policy', valueKey: `segment-policy-${tenantId}-${v(policy)}`,
        occurredAt: input.now(), source: 'api/customer', payload: policy,
        sameValue: (p) => v(p as SegmentPolicy) === v(policy),
      });
    },
    // FUL-12: a customer whose marketing profile was erased reads as an anonymous ref — the totals survive for the
    // shop's own figures, the person is no longer linkable (anonymisation as a compensating fact, never a deletion).
    orderFacts: async (tenantId) => {
      const anon = await anonymisedProfiles(input.store, tenantId);
      return latestPerId(await allOf<OrderFact>(input.store, tenantId, ORDER_FACTS_STREAM, 'CustomerOrderFactRecorded'), (o) => o.orderId)
        .map((o) => (anon.has(o.customerRef) ? { ...o, customerRef: anon.get(o.customerRef)! } : o));
    },
    complaintFacts: async (tenantId) => {
      const anon = await anonymisedProfiles(input.store, tenantId);
      return latestPerId(await allOf<ComplaintFact>(input.store, tenantId, COMPLAINT_FACTS_STREAM, 'CustomerComplaintFactRecorded'), (c) => c.caseId)
        .map((c) => (anon.has(c.customerRef) ? { ...c, customerRef: anon.get(c.customerRef)! } : c));
    },
    // FUL-12 prevent-restore: a new profile fact for an erased subject is refused at the route.
    erasedSubject: async (tenantId, customerRef) =>
      (await allOf<PrivacyTombstone>(input.store, tenantId, TOMBSTONE_STREAM, 'PrivacyTombstoneSealed')).some((t) => t.customerRef === customerRef),
    recordOrderFact: async (tenantId, fact) => {
      await input.store.append(tenantId, ORDER_FACTS_STREAM, makeEvent({
        id: `order-fact-${fact.orderId}`,
        type: 'CustomerOrderFactRecorded',
        occurredAt: input.now(),
        idempotencyKey: `order-fact-${tenantId}-${fact.orderId}-${fact.customerRef}-${fact.netMinor}-${fact.marginMinor}-${fact.at}-${fact.channel}`,
        source: 'api/customer',
        payload: fact,
      }));
    },
    recordComplaintFact: async (tenantId, fact) => {
      await input.store.append(tenantId, COMPLAINT_FACTS_STREAM, makeEvent({
        id: `complaint-fact-${fact.caseId}`,
        type: 'CustomerComplaintFactRecorded',
        occurredAt: input.now(),
        idempotencyKey: `complaint-fact-${tenantId}-${fact.caseId}-${fact.customerRef}-${fact.resolved}-${fact.at}`,
        source: 'api/customer',
        payload: fact,
      }));
    },
    // The SAME per-customer consent stream the campaign send-gate reads (P-02) — segmentation folds it
    // to a purpose-level view (services/customer/src/segments.ts collapseConsent), never a second copy.
    consentFor: async (tenantId, customerRef) =>
      allOf<ConsentRecord>(input.store, tenantId, forCustomer(customerRef), 'ConsentRecorded'),
  };
}

/**
 * The marketing-draft inputs for the A09 Marketing agent (M16-FR-02 / A09): one profile per known customer
 * built for the `marketing` purpose, plus each customer's folded consent — assembled from the SAME stored
 * order facts + consent ledger the stateful segmentation reads (P-02, never a second copy), exactly as the
 * `GET /v1/customer/segments/audience` route assembles them (refs from the orders; consent folded per ref,
 * any-channel — the binding per-channel check still runs at send time). Returns nothing to commit: A09 only
 * DRAFTS which audiences are worth a campaign (`draftMarketingAudiences` runs in the AI adapter).
 */
export async function marketingDraftInputs(
  input: { readonly store: EventStore; readonly now: () => string },
  tenantId: string,
): Promise<{ readonly profiles: readonly SegCustomerProfile[]; readonly consents: readonly SegCustomerConsent[] }> {
  const deps = segmentDataAdapter(input);
  const [orders, complaints, policy] = await Promise.all([
    deps.orderFacts(tenantId), deps.complaintFacts(tenantId), deps.policy(tenantId),
  ]);
  const refs = [...new Set(orders.map((o) => o.customerRef))];
  const consents = await Promise.all(refs.map(async (ref) => collapseConsent(ref, await deps.consentFor(tenantId, ref))));
  const profiles = assembleProfiles({ orders, complaints, consents, purpose: 'marketing', asOf: input.now(), policy: policy ?? {} });
  return { profiles, consents };
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
        id: keyedEventId('consent', `consent-${tenantId}-${r.customerId}-${r.purpose}-${r.channel}-${r.given ? 'given' : 'withdrawn'}-${r.recordedAt}`),
        type: 'ConsentRecorded',
        occurredAt: r.recordedAt,
        // Time is part of the key: consent given, withdrawn and given again is three facts about
        // the same customer, purpose and channel, and the middle one is the one a regulator asks
        // about. A key without the timestamp would keep only the first and call the rest replays. The direction
        // is in the key too: a withdrawal in the same millisecond as the grant is a second fact, not a replay.
        idempotencyKey: `consent-${tenantId}-${r.customerId}-${r.purpose}-${r.channel}-${r.given ? 'given' : 'withdrawn'}-${r.recordedAt}`,
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

    // The customer's points write guard (Wave 2a · PF-01): one version per customer, read before the balance and
    // bumped by every movement that lands.
    pointsVersion: (tenantId, customerId) => input.store.guardVersion(tenantId, `points:${customerId}`),

    recordPointsMovement: async (tenantId, customerId, m, expectedVersion, openingLoadId) => {
      await input.store.appendBatch(tenantId, [...(openingLoadId === undefined ? [] : [openingItemEntry(tenantId, { loadId: openingLoadId, domain: 'points', customerId, openedMinor: m.delta }, m.at)]), { stream: forCustomerPoints(customerId), event: makeEvent({
        id: `points-${m.movementId}`,
        type: 'PointsMovement',
        occurredAt: m.at,
        // The movement's own id, no timestamp — a lane retrying an unconfirmed burn collapses to one,
        // so points leave once however many times the till re-sends it.
        idempotencyKey: `points-${tenantId}-${m.movementId}`,
        source: 'api/customer',
        payload: m,
      }) }], expectedVersion === undefined ? undefined : { guard: { key: `points:${customerId}`, expectedVersion } });
    },
  };
}

const LOYALTY_MEMBERS = streamName(STREAM.loyalty, 'members');
const forSaleLoyalty = (saleId: string): string => streamName(STREAM.loyalty, 'sale', saleId);

/**
 * Loyalty members (PF-09-a · OB-28/OB-29): each enrolment and each leaving is a `LoyaltyMember` fact on one stream — the
 * member code and the last four digits, never the phone number (P-04). Append-only; the current state is the latest fact.
 */
export function loyaltyMembersAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly memberKey?: Buffer;
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
}): LoyaltyMemberDeps {
  const customers = customerAdapter({ store: input.store, now: input.now });
  return {
    ...(input.memberKey === undefined ? {} : { memberKey: input.memberKey }),
    memberHistory: async (tenantId, memberRef) =>
      (await allOf<MemberRecord>(input.store, tenantId, LOYALTY_MEMBERS, 'LoyaltyMember')).filter((m) => m.memberRef === memberRef),
    recordMember: async (tenantId, record, key) => {
      await input.store.append(tenantId, LOYALTY_MEMBERS, makeEvent({
        id: `loyalty-member-${key}`,
        type: 'LoyaltyMember',
        occurredAt: input.now(),
        idempotencyKey: `loyalty-member-${tenantId}-${key}`,
        source: 'api/customer',
        payload: record,
      }));
    },
    pointsBalance: customers.pointsBalance,
    rule: input.rule,
    now: input.now,
  };
}

/**
 * What a sale and a return do to a member's points (PF-09-a): each sale's loyalty facts fold their own small stream, so a
 * return reads only its sale's history. The earn and its points movement are ONE write; a take-back and its movement are
 * ONE write under the member's points guard (Wave 2a), so it can never race a burn into a negative balance.
 */
export function loyaltyEffectsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
}): LoyaltyEffectsDeps {
  const customers = customerAdapter({ store: input.store, now: input.now });
  const members = loyaltyMembersAdapter(input);
  const pointsEntry = (tenantId: string, m: RecordedPointsMovement) => ({
    stream: streamName(STREAM.loyalty, m.customerId),
    event: makeEvent({
      id: `points-${m.movementId}`, type: 'PointsMovement', occurredAt: m.at,
      idempotencyKey: `points-${tenantId}-${m.movementId}`, source: 'api/customer', payload: m,
    }),
  });
  return {
    rule: input.rule,
    memberHistory: members.memberHistory,
    saleLoyalty: async (tenantId, saleId) => {
      const events = await input.store.readStream(tenantId, forSaleLoyalty(saleId));
      const earn = events.find((e) => e.event.type === 'LoyaltySaleEarned');
      return {
        ...(earn === undefined ? {} : { earn: payloadOf<SaleEarn>(earn) }),
        takeBacks: events.filter((e) => e.event.type === 'LoyaltyReturnTakenBack').map((e) => payloadOf<ReturnTakeBack>(e)),
        giveBacks: events.filter((e) => e.event.type === 'LoyaltyReturnGaveBack').map((e) => payloadOf<ReturnGiveBack>(e)),
      };
    },
    pointsBalance: customers.pointsBalance,
    pointsVersion: (tenantId, memberRef) => input.store.guardVersion(tenantId, `points:${memberRef}`),
    recordEarn: async (tenantId, saleId, earn, at) => {
      await input.store.appendBatch(tenantId, [
        pointsEntry(tenantId, { movementId: `earn-${saleId}`, customerId: earn.memberRef, delta: earn.points, reason: 'earn', sourceRef: `sale:${saleId}`, at }),
        { stream: forSaleLoyalty(saleId), event: makeEvent({
          id: `loyalty-sale-earn-${saleId}`, type: 'LoyaltySaleEarned', occurredAt: at,
          idempotencyKey: `loyalty-sale-earn-${tenantId}-${saleId}`, source: 'api/customer', payload: earn,
        }) },
      ]);
    },
    recordTakeBack: async (tenantId, saleId, t, at, expectedVersion) => {
      await input.store.appendBatch(tenantId, [
        ...(t.taken > 0 ? [pointsEntry(tenantId, { movementId: `takeback-${t.returnId}`, customerId: t.memberRef, delta: -t.taken, reason: 'earn_reversal', sourceRef: `return:${t.returnId}`, at })] : []),
        { stream: forSaleLoyalty(saleId), event: makeEvent({
          id: `loyalty-takeback-${t.returnId}`, type: 'LoyaltyReturnTakenBack', occurredAt: at,
          idempotencyKey: `loyalty-takeback-${tenantId}-${saleId}-${t.returnId}`, source: 'api/customer', payload: t,
        }) },
      ], { guard: { key: `points:${t.memberRef}`, expectedVersion } });
    },
    // OB-34 "A": the points a bill was paid with — read from the member's own applied-spend fact for that bill.
    pointsSpentOnSale: async (tenantId, saleId) => {
      const held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`);
      if (held === undefined) return undefined;
      const sale = held.event.payload as { readonly customerRef?: unknown; readonly totalMinor?: unknown };
      if (typeof sale.customerRef !== 'string' || typeof sale.totalMinor !== 'number') return undefined;
      const ref = spendRefFor(saleId, 'loyalty_points');
      const fact = (await allOf<SpendApplied>(input.store, tenantId, streamName(STREAM.loyalty, 'spends', sale.customerRef), 'LoyaltySpendApplied')).find((f) => f.ref === ref);
      if (fact === undefined || (fact.pointsApplied ?? 0) <= 0) return undefined;
      return { memberRef: fact.memberRef, saleTotalMinor: sale.totalMinor, pointsApplied: fact.pointsApplied ?? 0, appliedMinor: fact.appliedMinor };
    },
    // The give-back and its points movement are ONE write under the member's points guard, like a take-back.
    recordGiveBack: async (tenantId, saleId, g, at, expectedVersion) => {
      await input.store.appendBatch(tenantId, [
        ...(g.points > 0 ? [pointsEntry(tenantId, { movementId: `giveback-${g.returnId}`, customerId: g.memberRef, delta: g.points, reason: 'burn_reversal', sourceRef: `return:${g.returnId}`, at })] : []),
        { stream: forSaleLoyalty(saleId), event: makeEvent({
          id: `loyalty-giveback-${g.returnId}`, type: 'LoyaltyReturnGaveBack', occurredAt: at,
          idempotencyKey: `loyalty-giveback-${tenantId}-${saleId}-${g.returnId}`, source: 'api/customer', payload: g,
        }) },
      ], { guard: { key: `points:${g.memberRef}`, expectedVersion } });
    },
    now: input.now,
  };
}

/**
 * Loyalty wallets (PF-09 step 3): the feed the store computers pull, and the spends a banked sale applies. A spend's points
 * leave under the member's points guard and its store credit leaves each instrument under that instrument's guard (Wave 2a),
 * so a till spend applied here can never race a desk redemption or a take-back into a negative balance. Each spend's own
 * fact lives on the member's spend stream — the feed lists them, so a box can tell its applied spends from its pending ones.
 */
const forMemberSpends = (memberRef: string): string => streamName(STREAM.loyalty, 'spends', memberRef);

export function loyaltyWalletsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
}): LoyaltyWalletDeps {
  const customers = customerAdapter({ store: input.store, now: input.now });
  const value = storedValueAdapter({ store: input.store, now: input.now });
  return {
    rule: input.rule,
    allMembers: (tenantId) => allOf<MemberRecord>(input.store, tenantId, LOYALTY_MEMBERS, 'LoyaltyMember'),
    pointsBalance: customers.pointsBalance,
    pointsVersion: (tenantId, memberRef) => input.store.guardVersion(tenantId, `points:${memberRef}`),
    storeCredit: async (tenantId, memberRef) => {
      const mine = (await value.instrumentsForOwner(tenantId, memberRef))
        .filter((i) => i.kind === 'store_credit')
        // Oldest first by issue time; two issued in the same millisecond keep the order head office recorded them (the
        // index is append-ordered and the sort is stable) — never the alphabetical order of their ids.
        .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
      return Promise.all(mine.map(async (instrument) => {
        // The guard version first, then the history it protects (Wave 2a).
        const version = await input.store.guardVersion(tenantId, `stored-value:${instrument.instrumentId}`);
        return { instrument, version, movements: await value.movements(tenantId, instrument.instrumentId) };
      }));
    },
    spendsApplied: (tenantId, memberRef) => allOf<SpendApplied>(input.store, tenantId, forMemberSpends(memberRef), 'LoyaltySpendApplied'),
    recordPointsSpend: async (tenantId, memberRef, m, expectedVersion) => {
      const movement: RecordedPointsMovement = { movementId: m.movementId, customerId: memberRef, delta: -m.points, reason: 'burn', sourceRef: m.sourceRef, at: m.at };
      await input.store.appendBatch(tenantId, [{ stream: forCustomerPoints(memberRef), event: makeEvent({
        id: `points-${m.movementId}`, type: 'PointsMovement', occurredAt: m.at,
        idempotencyKey: `points-${tenantId}-${m.movementId}`, source: 'api/customer', payload: movement,
      }) }], { guard: { key: `points:${memberRef}`, expectedVersion } });
    },
    recordCreditSpend: async (tenantId, instrumentId, m, expectedVersion) => {
      await value.recordMovement(tenantId, instrumentId, m, expectedVersion);
    },
    recordSpendApplied: async (tenantId, fact) => {
      await input.store.append(tenantId, forMemberSpends(fact.memberRef), makeEvent({
        id: `loyalty-spend-${fact.ref}`, type: 'LoyaltySpendApplied', occurredAt: fact.at,
        idempotencyKey: `loyalty-spend-${tenantId}-${fact.ref}`, source: 'api/customer', payload: fact,
      }));
    },
    now: input.now,
  };
}

/**
 * The loyalty liability, both sides (PF-09 step 3): what every member holds (their points, from their movements; every
 * store-credit instrument's balance) and what the books carry (the credit balance of an account across every posted
 * journal). Two derivations; the route compares them exactly.
 */
export function loyaltyLiabilityAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
}): LoyaltyLiabilityDeps {
  const customers = customerAdapter({ store: input.store, now: input.now });
  const value = storedValueAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    outstanding: async (tenantId) => {
      const codes = [...new Set((await allOf<MemberRecord>(input.store, tenantId, LOYALTY_MEMBERS, 'LoyaltyMember')).map((m) => m.memberRef))];
      let points = 0;
      for (const code of codes) points += Math.max(0, (await customers.pointsBalance(tenantId, code)) ?? 0);
      const instruments = (await allOf<Instrument>(input.store, tenantId, STORED_VALUE_INDEX, 'StoredValueIssued')).filter((i) => i.kind === 'store_credit');
      let storeCreditMinor = 0;
      for (const i of instruments) storeCreditMinor += Math.max(0, balanceOf(await value.movements(tenantId, i.instrumentId), i.instrumentId));
      return { points, pointValuePaise: (await input.rule(tenantId)).pointValuePaise, storeCreditMinor };
    },
    creditBalance: async (tenantId, accountCode) => {
      const journals = await allOf<JournalEntry>(input.store, tenantId, STREAM.finance, 'JournalPosted');
      let balance = 0;
      for (const j of journals) for (const l of j.lines) if (l.accountCode === accountCode) balance += l.creditMinor - l.debitMinor;
      return balance;
    },
  };
}

/**
 * Independent evidence for the close (PF-12): bank statements on their own stream with their provenance, and the month's
 * comparison built from the sales ledger's card/UPI tenders, every imported provider settlement file and every statement.
 */
const BANK_STATEMENTS = streamName(STREAM.settlement, 'bank-statements');

export function independentEvidenceAdapter(input: { readonly store: EventStore; readonly now: () => string }): IndependentEvidenceDeps {
  const statements = (tenantId: string) => allOf<ImportedStatement>(input.store, tenantId, BANK_STATEMENTS, 'BankStatementImported');
  return {
    now: input.now,
    statements,
    recordStatement: async (tenantId, statement) => {
      await input.store.append(tenantId, BANK_STATEMENTS, makeEvent({
        id: `bank-statement-${statement.statementId}`, type: 'BankStatementImported', occurredAt: statement.provenance.importedAt,
        // The statement's own id — importing the same statement twice collapses (the route also refuses it by name).
        idempotencyKey: `bank-statement-${tenantId}-${statement.statementId}`, source: 'api/finance', payload: statement,
      }));
    },
    evidenceFor: async (tenantId, period) => {
      const start = Date.parse(`${period}-01T00:00:00.000Z`);
      const from = new Date(start - 2 * 86_400_000).toISOString();
      const to = new Date(start + 33 * 86_400_000).toISOString();
      const sales = (await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from, to }))
        .map((e) => e.event.payload as IncomingSale)
        .filter((sale) => (sale.tradingDay !== '' ? sale.tradingDay : sale.committedAt).slice(0, 7) === period);
      const tenders = sales.flatMap((sale) => sale.tenders
        .filter((t) => typeof t.ref === 'string' && t.ref.trim() !== '')
        .map((t) => ({ ref: t.ref as string, kind: t.kind, amountMinor: t.amountMinor, saleId: sale.saleId })));
      const batches = await allOf<SettlementBatch>(input.store, tenantId, STREAM.settlement, 'SettlementBatchImported');
      const base = monthEvidence({ period, tenders, batches, statements: await statements(tenantId) });
      // WF-18: the books reconciled to their registers inside the close (stock adjustments, payables, receivables).
      const books = await bookChecksFor(input, tenantId, period);
      return { ...base, checks: [...base.checks, ...books.checks], notChecked: [...base.notChecked, ...books.notChecked], books: books.books };
    },
  };
}

/**
 * PF-11: carrying a granted compensation out — store credit through the stored-value records (keyed on the
 * compensation, so a retry issues nothing twice), points through the customer's points under their write guard — and
 * every attempt's status on the compensation stream (append-only; the latest per compensation is its state).
 */
const SERVICE_FULFILMENT_STREAM = streamName(STREAM.service, 'compensation-fulfilment');

export function compensationFulfilmentAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly pointValuePaise: (tenantId: string) => Promise<number>;
}): Pick<ServiceCaseDeps, 'fulfilCompensation' | 'recordFulfilment' | 'fulfilments'> {
  const value = storedValueAdapter({ store: input.store, now: input.now });
  const customers = customerAdapter({ store: input.store, now: input.now });
  const ports: FulfilmentPorts = {
    now: input.now,
    pointValuePaise: input.pointValuePaise,
    issueStoreCredit: async (tenantId, instrument, opening) => {
      if (await value.instrument(tenantId, instrument.instrumentId) !== undefined) return; // issued already — once
      await value.recordIssue(tenantId, instrument, opening);
    },
    addPoints: async (tenantId, customerRef, m) => {
      for (let attempt = 0; ; attempt += 1) {
        const version = await input.store.guardVersion(tenantId, `points:${customerRef}`);
        try {
          await customers.recordPointsMovement(tenantId, customerRef, { movementId: m.movementId, customerId: customerRef, delta: m.points, reason: 'earn', sourceRef: m.sourceRef, at: m.at }, version);
          return;
        } catch (err) {
          if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
          throw err;
        }
      }
    },
  };
  return {
    fulfilCompensation: (tenantId, i) => fulfilCompensation(ports, tenantId, i),
    recordFulfilment: async (tenantId, f) => {
      await input.store.append(tenantId, SERVICE_FULFILMENT_STREAM, makeEvent({
        id: keyedEventId('comp-fulfil', `comp-fulfil-${tenantId}-${f.compensationId}-${f.status}-${f.at}`), type: 'CompensationFulfilment', occurredAt: f.at,
        idempotencyKey: `comp-fulfil-${tenantId}-${f.compensationId}-${f.status}-${f.at}`, source: 'api/customer', payload: f,
      }));
    },
    fulfilments: async (tenantId, caseId) =>
      (await allOf<CompensationFulfilment>(input.store, tenantId, SERVICE_FULFILMENT_STREAM, 'CompensationFulfilment')).filter((f) => f.caseId === caseId),
  };
}

export function dataRightsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DataRightsDeps {
  // Every recorded state of every request, folded to the LATEST per request id by append order (not by
  // timestamp — two transitions on the same day must still resolve to the later one deterministically).
  const foldLatest = async (tenantId: string): Promise<readonly DataSubjectRequest[]> => {
    const all = await allOf<DataSubjectRequest>(input.store, tenantId, DATA_REQUESTS_STREAM, 'DataSubjectRequestRecorded');
    const byId = new Map<string, DataSubjectRequest>();
    for (const r of all) byId.set(r.requestId, r);
    return [...byId.values()];
  };
  return {
    now: input.now,
    requests: (tenantId) => foldLatest(tenantId),
    request: async (tenantId, requestId) => (await foldLatest(tenantId)).find((r) => r.requestId === requestId),
    record: async (tenantId, requestId, request, key) => {
      await input.store.append(tenantId, DATA_REQUESTS_STREAM, makeEvent({
        id: `data-request-${key}`,
        type: 'DataSubjectRequestRecorded',
        occurredAt: input.now(),
        // Keyed on the request AND the transition (raised/verified/…): a re-sync of one transition
        // collapses, but each new state is a new, append-only fact — the trail an auditor reads.
        idempotencyKey: `data-request-${tenantId}-${key}`,
        source: 'api/customer',
        payload: request,
      }));
    },
  };
}

/**
 * Erasure EXECUTION (M20-FR-04 / DPDP) — carrying out a verified erasure under the two-person control. Four
 * append-only sub-streams: located-PII holdings folded to the latest state per (customer, category) — the
 * simulated, provider-neutral source the executor acts on; the checker's approvals (latest per request); the
 * sealed PII-free tombstones; and the processor-erasure notices enqueued on the connector queue. Request
 * lifecycle rides the SAME `DataSubjectRequestRecorded` stream as the data-rights routes, so a `GET
 * …/data-requests/:id` reflects the fulfilled state after execution. Everything rebuilds from the store on a
 * cold restart, so the tombstone, the holdings' erased/minimised state and the approval all survive.
 */
export function erasureExecutionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ErasureExecutionDeps {
  const foldRequests = async (tenantId: string): Promise<Map<string, DataSubjectRequest>> => {
    const all = await allOf<DataSubjectRequest>(input.store, tenantId, DATA_REQUESTS_STREAM, 'DataSubjectRequestRecorded');
    const byId = new Map<string, DataSubjectRequest>();
    for (const r of all) byId.set(r.requestId, r);
    return byId;
  };
  const foldPii = async (tenantId: string, customerRef: string): Promise<readonly PiiEntry[]> => {
    const all = await allOf<PiiEntry>(input.store, tenantId, PII_STREAM, 'CustomerPiiRecorded');
    const byKey = new Map<string, PiiEntry>();
    for (const e of all) if (e.customerRef === customerRef) byKey.set(e.category, e); // latest state per category
    return [...byKey.values()];
  };
  return {
    now: input.now,
    request: async (tenantId, requestId) => (await foldRequests(tenantId)).get(requestId),
    recordRequest: async (tenantId, requestId, request, key) => {
      await input.store.append(tenantId, DATA_REQUESTS_STREAM, makeEvent({
        id: `data-request-${key}`, type: 'DataSubjectRequestRecorded', occurredAt: input.now(),
        idempotencyKey: `data-request-${tenantId}-${key}`, source: 'api/customer', payload: request,
      }));
    },
    piiFor: (tenantId, customerRef) => foldPii(tenantId, customerRef),
    recordPii: async (tenantId, entry, key) => {
      await input.store.append(tenantId, PII_STREAM, makeEvent({
        id: `pii-${key}`, type: 'CustomerPiiRecorded', occurredAt: input.now(),
        idempotencyKey: `pii-${tenantId}-${key}`, source: 'api/customer', payload: entry,
      }));
    },
    approvalFor: async (tenantId, requestId) => {
      const all = await allOf<ErasureApproval>(input.store, tenantId, ERASURE_APPROVAL_STREAM, 'ErasureApproved');
      let latest: ErasureApproval | undefined;
      for (const a of all) if (a.requestId === requestId) latest = a; // latest approval wins
      return latest;
    },
    recordApproval: async (tenantId, approval, key) => {
      await input.store.append(tenantId, ERASURE_APPROVAL_STREAM, makeEvent({
        id: `erasure-approval-${key}`, type: 'ErasureApproved', occurredAt: input.now(),
        idempotencyKey: `erasure-approval-${tenantId}-${key}`, source: 'api/customer', payload: approval,
      }));
    },
    tombstonesFor: (tenantId) => allOf<PrivacyTombstone>(input.store, tenantId, TOMBSTONE_STREAM, 'PrivacyTombstoneSealed'),
    tombstoneFor: async (tenantId, requestId) =>
      (await allOf<PrivacyTombstone>(input.store, tenantId, TOMBSTONE_STREAM, 'PrivacyTombstoneSealed')).find((t) => t.requestId === requestId),
    recordTombstone: async (tenantId, tombstone, key) => {
      await input.store.append(tenantId, TOMBSTONE_STREAM, makeEvent({
        id: `tombstone-${key}`, type: 'PrivacyTombstoneSealed', occurredAt: input.now(),
        idempotencyKey: `tombstone-${tenantId}-${key}`, source: 'api/customer', payload: tombstone,
      }));
    },
    enqueueNotice: async (tenantId, message, key) => {
      await input.store.append(tenantId, PRIVACY_NOTICE_STREAM, makeEvent({
        id: `privacy-notice-${key}`, type: 'ProcessorNoticeEnqueued', occurredAt: input.now(),
        idempotencyKey: `privacy-notice-${tenantId}-${key}`, source: 'api/customer', payload: message,
      }));
    },
  };
}

export function serviceCaseAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ServiceCaseDeps {
  const foldLatest = async (tenantId: string): Promise<readonly ServiceCase[]> => {
    const all = await allOf<ServiceCase>(input.store, tenantId, SERVICE_CASE_STREAM, 'ServiceCaseRecorded');
    const byId = new Map<string, ServiceCase>();
    for (const c of all) byId.set(c.caseId, c); // later state wins (open → reply → resolved)
    return [...byId.values()];
  };
  return {
    now: input.now,
    serviceCases: (tenantId) => foldLatest(tenantId),
    serviceCase: async (tenantId, caseId) => (await foldLatest(tenantId)).find((c) => c.caseId === caseId),
    recordCase: async (tenantId, caseId, c, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, SERVICE_CASE_STREAM, makeEvent({
        id: `service-case-${caseId}-${d}`,
        type: 'ServiceCaseRecorded',
        occurredAt: input.now(),
        // Keyed on the case and a digest of its state — a re-send collapses; each transition (open,
        // first reply, resolved) is a new append-only fact, the fold taking the latest.
        idempotencyKey: `service-case-${tenantId}-${caseId}-${d}`,
        source: 'api/customer',
        payload: c,
      }));
    },

    // Append-only compensation ledger; the read filters the tenant's grants to one case.
    compensations: async (tenantId, caseId) =>
      (await allOf<CompensationRecord>(input.store, tenantId, SERVICE_COMPENSATION_STREAM, 'CompensationGranted')).filter((r) => r.caseId === caseId),
    recordCompensation: async (tenantId, caseId, rec, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, SERVICE_COMPENSATION_STREAM, makeEvent({
        id: `service-comp-${caseId}-${d}`,
        type: 'CompensationGranted',
        occurredAt: rec.at,
        // A re-synced grant collapses on the case+amount+granter+time; never doubles the payment.
        idempotencyKey: `service-comp-${tenantId}-${d}`,
        source: 'api/customer',
        payload: rec,
      }));
    },

    // The tenant's compensation authority limits (M21-FR-03) — append-only config, the latest set wins.
    compensationPolicy: async (tenantId) => {
      const all = await allOf<CompensationPolicy>(input.store, tenantId, SERVICE_POLICY_STREAM, 'CompensationPolicySet');
      return all.length === 0 ? undefined : all[all.length - 1];
    },
    recordCompensationPolicy: async (tenantId, policy, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, SERVICE_POLICY_STREAM, makeEvent({
        id: `service-comp-policy-${d}`,
        type: 'CompensationPolicySet',
        occurredAt: input.now(),
        idempotencyKey: `service-comp-policy-${tenantId}-${d}`,
        source: 'api/customer',
        payload: policy,
      }));
    },
    // The §28 authority to approve an over-limit compensation — service.compensation.approve, owner-only by
    // default. A named approver who does not hold it does not count (the same check as price-change approval).
    canApproveCompensation: async (tenantId, userId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
      return ROLE_CATALOGUE.some((r) => roleIds.has(r.id) && r.permissions.includes('service.compensation.approve'));
    },

    // AI drafts and their decisions (P-05) — both on the drafts stream, filtered by case.
    drafts: async (tenantId, caseId) =>
      (await allOf<AiDraft>(input.store, tenantId, SERVICE_DRAFT_STREAM, 'AiDraftRecorded')).filter((d) => d.caseId === caseId),
    draft: async (tenantId, caseId, draftId) =>
      (await allOf<AiDraft>(input.store, tenantId, SERVICE_DRAFT_STREAM, 'AiDraftRecorded')).find((d) => d.caseId === caseId && d.draftId === draftId),
    recordDraft: async (tenantId, caseId, draft, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, SERVICE_DRAFT_STREAM, makeEvent({
        id: `service-draft-${caseId}-${d}`, type: 'AiDraftRecorded', occurredAt: draft.generatedAt,
        idempotencyKey: `service-draft-${tenantId}-${d}`, source: 'api/customer', payload: draft,
      }));
    },
    // Latest decision per draft (an edit can supersede an earlier decision), folded by append order.
    draftDecisions: async (tenantId, caseId) => {
      const all = (await allOf<DraftDecisionRecord>(input.store, tenantId, SERVICE_DRAFT_STREAM, 'DraftDecided')).filter((r) => r.caseId === caseId);
      const byId = new Map<string, DraftDecisionRecord>();
      for (const r of all) byId.set(r.draftId, r);
      return [...byId.values()];
    },
    recordDraftDecision: async (tenantId, caseId, rec, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, SERVICE_DRAFT_STREAM, makeEvent({
        id: `service-decision-${caseId}-${d}`, type: 'DraftDecided', occurredAt: rec.at,
        idempotencyKey: `service-decision-${tenantId}-${d}`, source: 'api/customer', payload: rec,
      }));
    },

    // CSAT scores (M21-FR-04) — tenant-wide append-only ledger; the report folds every score.
    scores: (tenantId) => allOf<SatisfactionScore>(input.store, tenantId, SERVICE_CSAT_STREAM, 'SatisfactionRecorded'),
    recordScore: async (tenantId, caseId, score, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, SERVICE_CSAT_STREAM, makeEvent({
        id: `service-csat-${caseId}-${d}`, type: 'SatisfactionRecorded', occurredAt: score.at,
        idempotencyKey: `service-csat-${tenantId}-${d}`, source: 'api/customer', payload: score,
      }));
    },
  };
}

export function campaignAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): CampaignDeps {
  return {
    now: input.now,
    // The SAME consent ledger the customer service reads (P-02) — folded per recipient at the send.
    consentRecords: (tenantId, customerId) =>
      allOf<ConsentRecord>(input.store, tenantId, forCustomer(customerId), 'ConsentRecorded'),
    // PF-10: the same message-template register the notification queue enqueues from (PA-08).
    templates: (tenantId) => allOf<MessageTemplateVersion>(input.store, tenantId, streamName(STREAM.org, 'message-templates'), 'MessageTemplateVersion'),
    plans: (tenantId) => allOf<CampaignPlanRecord>(input.store, tenantId, CAMPAIGN_PLAN_STREAM, 'CampaignPlanned'),
    recordPlan: async (tenantId, rec, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, CAMPAIGN_PLAN_STREAM, makeEvent({
        id: `campaign-plan-${rec.campaignId}-${d}`,
        type: 'CampaignPlanned',
        occurredAt: rec.at,
        // Each planning run is its own append-only fact — the same campaign planned twice is two
        // decisions; a re-sent request (same idempotency key) collapses.
        idempotencyKey: `campaign-plan-${tenantId}-${d}`,
        source: 'api/customer',
        payload: rec,
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

    recordIssue: async (tenantId, instrument, opening, openingLoadId) => {
      // The instrument goes on the shared index (so it can be found and, later, pooled by owner); its
      // opening value is the first movement on the instrument's own stream, where the balance folds. One atomic write — with
      // a load's opening-item register entry when a migration load opened it (round 7).
      await input.store.appendBatch(tenantId, [{ stream: STORED_VALUE_INDEX, event: makeEvent({
        id: `sv-issue-${instrument.instrumentId}`,
        type: 'StoredValueIssued',
        occurredAt: instrument.issuedAt,
        idempotencyKey: `sv-issue-${tenantId}-${instrument.instrumentId}`,
        source: 'api/customer',
        payload: instrument,
      }) }, { stream: forInstrument(instrument.instrumentId), event: makeEvent({
        id: `sv-mv-${opening.movementId}`,
        type: 'StoredValueMovement',
        occurredAt: opening.at,
        idempotencyKey: `sv-mv-${tenantId}-${opening.movementId}`,
        source: 'api/customer',
        payload: opening,
      }) }, ...(openingLoadId === undefined ? [] : [openingItemEntry(tenantId, { loadId: openingLoadId, domain: 'stored_value', instrumentId: instrument.instrumentId, openedMinor: opening.deltaMinor }, opening.at)])]);
    },

    // The instrument's write guard (Wave 2a · PF-01): one version per card, read before the balance and bumped by
    // every movement that lands on it.
    instrumentVersion: (tenantId, instrumentId) => input.store.guardVersion(tenantId, `stored-value:${instrumentId}`),

    recordMovement: async (tenantId, instrumentId, m, expectedVersion) => {
      await input.store.appendBatch(tenantId, [{ stream: forInstrument(instrumentId), event: makeEvent({
        id: `sv-mv-${m.movementId}`,
        type: 'StoredValueMovement',
        occurredAt: m.at,
        // The movement's own id, no timestamp — a re-sent redemption collapses, so a gift card is
        // spent once however many times the till re-sends it.
        idempotencyKey: `sv-mv-${tenantId}-${m.movementId}`,
        source: 'api/customer',
        payload: m,
      }) }], expectedVersion === undefined ? undefined : { guard: { key: `stored-value:${instrumentId}`, expectedVersion } });
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
  /** Where a refund's money moves (M18-FR-04). Absent means the test-mode processor — the only one that exists until EX-03. */
  readonly refundProcessor?: RefundProcessor;
}): OrdersDeps & PaymentRefundDeps & StorefrontDeps & ExceptionOwnershipDeps {
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
    outstanding: (tenantId, locationId) => outstandingReservationsAt(input.store, tenantId, locationId, input.now()),
    // D05-FR-03 (round 8): the store's online safety-stock buffer — units the app keeps back from what it promises.
    onlineBuffer: async (tenantId, locationId) => buffersAt(await allOf<OnlineBuffer>(input.store, tenantId, ONLINE_BUFFER_STREAM, 'OnlineBufferSet'), locationId).forProduct,

    // The location's promise guard (Wave 2a · FUL-02): one version per location, read before the stock and the holds.
    reservationVersion: (tenantId, locationId) => input.store.guardVersion(tenantId, reservationGuardKey(locationId)),

    // One promise's holds are ONE atomic batch (all land or none), under the location's guard when the route read one
    // (Wave 2a · FUL-02) — before, each hold was its own append and a race could land half an order's holds.
    holdReservations: async (tenantId, rs, expectedVersion) => {
      if (rs.length === 0) return;
      const locationId = rs[0]!.locationId;
      await input.store.appendBatch(tenantId, rs.map((r) => ({ stream: forLocation(r.locationId), event: makeEvent({
        id: `res-${r.reservationId}`,
        type: 'ReservationHeld',
        occurredAt: input.now(),
        idempotencyKey: `res-${tenantId}-${r.reservationId}`,
        source: 'api/orders',
        payload: r,
      }) })), expectedVersion === undefined ? undefined : { guard: { key: reservationGuardKey(locationId), expectedVersion } });
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
      // SF-10: and on the shop-wide order index, so the export reads every order. Idempotent on the order id.
      await input.store.append(tenantId, forOrderIndex, makeEvent({
        id: `ord-placed-idx-${order.orderId}`,
        type: 'OrderPlaced',
        occurredAt: order.placedAt,
        idempotencyKey: `ord-placed-idx-${tenantId}-${order.orderId}`,
        source: 'api/orders',
        payload: order,
      }));
      // A storefront order is also indexed under its customer, so "my orders" folds without walking every order.
      if (order.customerRef !== undefined) {
        await input.store.append(tenantId, forCustomerOrders(order.customerRef), makeEvent({
          id: `ord-placed-cust-${order.orderId}`,
          type: 'OrderPlaced',
          occurredAt: order.placedAt,
          idempotencyKey: `ord-placed-cust-${tenantId}-${order.customerRef}-${order.orderId}`,
          source: 'api/orders',
          payload: order,
        }));
      }
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
      // Also index it tenant-wide so the exception worklist folds without walking every order. Its own
      // idempotency key (distinct from the per-order one) means a replay appends both, but folds once.
      await input.store.append(tenantId, forSubstitutionIndex, makeEvent({
        id: `ord-sub-idx-${sub.orderId}-${sub.lineId}`,
        type: 'LineSubstituted',
        occurredAt: sub.at,
        idempotencyKey: `ord-sub-idx-${tenantId}-${sub.orderId}-${sub.lineId}`,
        source: 'api/orders',
        payload: sub,
      }));
    },

    /** The substitution decisions recorded on an order — a fold of its `LineSubstituted` events. */
    orderSubstitutions: async (tenantId, orderId) =>
      allOf<StoredSubstitution>(input.store, tenantId, forOrder(orderId), 'LineSubstituted'),

    /** Every substitution decision recorded for the tenant — a fold of the tenant-wide index, so the
     *  exception worklist (M19-FR-01) is answered shop-wide without reading each order's stream. */
    allSubstitutions: async (tenantId) =>
      allOf<StoredSubstitution>(input.store, tenantId, forSubstitutionIndex, 'LineSubstituted'),

    /** The kept ownership state of every exception a person has acted on — latest per exception id
     *  (M19-FR-01 / Item 2). Each human move appends the whole item with its history; the fold keeps the
     *  last, so a claim, release, escalation or resolution is never an edit (hard rule #2). */
    ownedExceptions: async (tenantId) => {
      const all = await allOf<OwnedException>(input.store, tenantId, forExceptionOwnership, 'SubstitutionExceptionOwned');
      const latest = new Map<string, OwnedException>();
      for (const o of all) latest.set(o.exceptionId, o);
      return [...latest.values()];
    },
    /** Keep an owned exception after a move. Keyed on the item's history length, so a replayed move lands once. */
    recordOwnedException: async (tenantId, owned) => {
      await input.store.append(tenantId, forExceptionOwnership, makeEvent({
        id: `sub-exc-${owned.exceptionId}-${owned.history.length}`,
        type: 'SubstitutionExceptionOwned',
        occurredAt: owned.history[owned.history.length - 1]?.at ?? input.now(),
        idempotencyKey: `sub-exc-${tenantId}-${owned.exceptionId}-${owned.history.length}`,
        source: 'api/orders',
        payload: owned,
      }));
    },
    /** The catalogue roles the caller holds here, from the append-only grant history — which exception
     *  queues they staff is decided from this, never from what the request says about itself. */
    rolesOf: async (tenantId, userId) =>
      (await effectiveGrants(input.store, tenantId))
        .filter((g) => g.userId === userId)
        .map((g) => g.roleId),

    /** Record a backorder against an order, append-only (M18-FR-02). Idempotent on the order id — the
     *  shortfall is recorded once, so a replay is one fact, never a second backorder. */
    recordBackorder: async (tenantId, bo: StoredBackorder) => {
      await input.store.append(tenantId, forOrder(bo.orderId), makeEvent({
        id: `ord-bo-${bo.orderId}`,
        type: 'OrderBackordered',
        occurredAt: bo.at,
        idempotencyKey: `ord-bo-${tenantId}-${bo.orderId}`,
        source: 'api/orders',
        payload: bo,
      }));
    },

    /** The backorders recorded against an order — a fold of its `OrderBackordered` events. */
    orderBackorders: async (tenantId, orderId) =>
      allOf<StoredBackorder>(input.store, tenantId, forOrder(orderId), 'OrderBackordered'),

    // ── Payment and refunds (M18-FR-04 / M20-FR-03) — append-only on the order's stream, indexed tenant-wide ──
    orderPayment: async (tenantId, orderId) => latest<OrderPayment>(input.store, tenantId, forOrder(orderId), 'OrderPaymentRecorded'),
    paymentResolution: async (tenantId, orderId) => latest<OrderPaymentResolution>(input.store, tenantId, forOrder(orderId), 'OrderPaymentResolved'),
    recordPayment: async (tenantId, p) => {
      for (const [stream, tag] of [[forOrder(p.orderId), ''], [forPaymentIndex, 'idx-']] as const) {
        await input.store.append(tenantId, stream, makeEvent({
          id: `ord-pay-${tag}${p.orderId}`, type: 'OrderPaymentRecorded', occurredAt: p.recordedAt,
          idempotencyKey: `ord-pay-${tag}${tenantId}-${p.orderId}`, source: 'api/orders', payload: p,
        }));
      }
    },
    recordPaymentResolution: async (tenantId, r) => {
      for (const [stream, tag] of [[forOrder(r.orderId), ''], [forPaymentIndex, 'idx-']] as const) {
        await input.store.append(tenantId, stream, makeEvent({
          id: `ord-pay-res-${tag}${r.orderId}`, type: 'OrderPaymentResolved', occurredAt: r.resolvedAt,
          idempotencyKey: `ord-pay-res-${tag}${tenantId}-${r.orderId}`, source: 'api/orders', payload: r,
        }));
      }
    },
    orderRefunds: async (tenantId, orderId) => allOf<OrderRefund>(input.store, tenantId, forOrder(orderId), 'OrderRefundIssued'),
    refundOutcomes: async (tenantId, orderId) => allOf<OrderRefundOutcome>(input.store, tenantId, forOrder(orderId), 'OrderRefundResolved'),
    recordRefund: async (tenantId, r) => {
      for (const [stream, tag] of [[forOrder(r.orderId), ''], [forRefundIndex, 'idx-']] as const) {
        await input.store.append(tenantId, stream, makeEvent({
          id: `ord-rf-${tag}${r.orderId}-${r.refundId}`, type: 'OrderRefundIssued', occurredAt: r.at,
          idempotencyKey: `ord-rf-${tag}${tenantId}-${r.orderId}-${r.refundId}`, source: 'api/orders', payload: r,
        }));
      }
    },
    recordRefundOutcome: async (tenantId, o) => {
      for (const [stream, tag] of [[forOrder(o.orderId), ''], [forRefundIndex, 'idx-']] as const) {
        await input.store.append(tenantId, stream, makeEvent({
          id: `ord-rf-res-${tag}${o.orderId}-${o.refundId}`, type: 'OrderRefundResolved', occurredAt: o.at,
          idempotencyKey: `ord-rf-res-${tag}${tenantId}-${o.orderId}-${o.refundId}`, source: 'api/orders', payload: o,
        }));
      }
    },
    allPayments: async (tenantId) => allOf<OrderPayment>(input.store, tenantId, forPaymentIndex, 'OrderPaymentRecorded'),
    allPaymentResolutions: async (tenantId) => allOf<OrderPaymentResolution>(input.store, tenantId, forPaymentIndex, 'OrderPaymentResolved'),
    allRefunds: async (tenantId) => allOf<OrderRefund>(input.store, tenantId, forRefundIndex, 'OrderRefundIssued'),
    allRefundOutcomes: async (tenantId) => allOf<OrderRefundOutcome>(input.store, tenantId, forRefundIndex, 'OrderRefundResolved'),
    // The SAME refund-approval threshold the till's returns use (M13-FR-03) — one policy for money going back.
    refundThreshold: async (tenantId) => {
      const all = await allOf<{ thresholdMinor: number }>(input.store, tenantId, streamName(STREAM.returns, 'refund-threshold'), 'RefundThresholdSet');
      const last = all[all.length - 1];
      return last === undefined ? undefined : last.thresholdMinor;
    },
    refundProcessor: input.refundProcessor ?? testModeRefundProcessor(),

    // ── Storefront (M20): who placed it, my orders, and the refusal register ──
    placedOrder: async (tenantId, orderId) => latest<PlacedOrder>(input.store, tenantId, forOrder(orderId), 'OrderPlaced'),
    ordersForCustomer: async (tenantId, customerRef) => allOf<PlacedOrder>(input.store, tenantId, forCustomerOrders(customerRef), 'OrderPlaced'),
    recordAccessRefusal: async (tenantId, r: StorefrontAccessRefusal) => {
      await input.store.append(tenantId, forStorefrontRefusals, makeEvent({
        id: keyedEventId('sf-refused', `sf-refused-${tenantId}-${r.customerRef}-${r.orderId}-${r.action}-${r.at}`),
        type: 'StorefrontAccessRefused',
        occurredAt: r.at,
        idempotencyKey: `sf-refused-${tenantId}-${r.customerRef}-${r.orderId}-${r.action}-${r.at}`,
        source: 'api/orders',
        payload: r,
      }));
    },
    accessRefusals: async (tenantId) => allOf<StorefrontAccessRefusal>(input.store, tenantId, forStorefrontRefusals, 'StorefrontAccessRefused'),
  };
}

/** The set of reservation ids released (cancelled) at a location — folded from the release ledger. */
/**
 * The holds at a location that still stand — held, not lapsed and not released (M18-FR-04). ONE reading for the order
 * promise and for a transfer out of the same stock (SF-03): stock promised to a customer is not stock to send away.
 */
async function outstandingReservationsAt(store: EventStore, tenantId: string, locationId: string, now: string): Promise<readonly Reservation[]> {
  const held = await allOf<Reservation>(store, tenantId, forLocation(locationId), 'ReservationHeld');
  const released = await releasedIds(store, tenantId, locationId);
  const lapsed = new Set(expired(held, now).map((r) => r.reservationId));
  return held.filter((r) => !released.has(r.reservationId) && !lapsed.has(r.reservationId));
}

async function releasedIds(
  store: EventStore, tenantId: string, locationId: string,
): Promise<ReadonlySet<string>> {
  const released = await allOf<{ reservationId: string }>(
    store, tenantId, forLocation(locationId), 'ReservationReleased');
  return new Set(released.map((r) => r.reservationId));
}

/** FUL-05: every door attempt on one order, indexed beside the driver's run. */
const forOrderAttempts = (orderId: string): string => streamName(STREAM.delivery, 'order-attempts', orderId);
export const orderAttemptsOf = (store: EventStore, tenantId: string, orderId: string): Promise<readonly DeliveryAttempt[]> =>
  allOf<DeliveryAttempt>(store, tenantId, forOrderAttempts(orderId), 'DeliveryAttemptIndexed');

export function fulfilmentAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FulfilmentDeps {
  return {
    now: input.now,

    // The run IS the stream; and (FUL-05) the same attempt is indexed on the ORDER in the same atomic batch, so the order's
    // fulfilment reads the cash its door took without scanning every driver's every day.
    appendAttempt: async (tenantId, a) => {
      await input.store.appendBatch(tenantId, [
        { stream: forDriverRun(a.driverId, a.attemptedAt.slice(0, 10)), event: makeEvent({
          id: `att-${a.attemptId}`,
          type: 'DeliveryAttempted',
          occurredAt: a.attemptedAt,
          idempotencyKey: `att-${tenantId}-${a.attemptId}`,
          source: 'api/fulfilment',
          payload: a,
        }) },
        { stream: forOrderAttempts(a.orderId), event: makeEvent({
          id: `att-order-${a.attemptId}`,
          type: 'DeliveryAttemptIndexed',
          occurredAt: a.attemptedAt,
          idempotencyKey: `att-order-${tenantId}-${a.attemptId}`,
          source: 'api/fulfilment',
          payload: a,
        }) },
      ]);
    },

    // The run IS the stream. Settling one driver's Tuesday no longer reads every delivery the
    // shop has ever made — and the two filters that used to do it are now the stream's name.
    attempts: (tenantId, driverId, runDate) =>
      allOf<DeliveryAttempt>(input.store, tenantId, forDriverRun(driverId, runDate), 'DeliveryAttempted'),

    /**
     * What dispatch gave the driver — the order ids that run is answerable for. Now that the dispatch
     * plan is persisted (`dispatchAdapter`), this reads it: `reconcileRun` can finally tell a delivery
     * made against an order nobody dispatched from one it did. Before, an empty list made every run
     * reconcile perfectly, hiding exactly that.
     */
    assigned: async (tenantId, driverId, runDate) => {
      const plans = await allOf<DispatchPlan>(input.store, tenantId, streamName(STREAM.delivery, 'dispatch', runDate), 'DispatchPlanned');
      const plan = plans[plans.length - 1]; // occurrence order → the latest plan/reassign wins
      return plan === undefined ? [] : assignedOrderIds(plan, driverId);
    },

    // One order IS a stream: reading where a single order has got to no longer scans every delivery the shop
    // has ever made. The append-only history folds to the current state by occurrence order (latest `to` wins).
    deliveryState: (tenantId, orderId) =>
      allOf<DeliveryStateRecord>(input.store, tenantId, streamName(STREAM.delivery, 'order', orderId), 'DeliveryStateChanged'),

    recordDeliveryTransition: async (tenantId, record) => {
      await input.store.append(tenantId, streamName(STREAM.delivery, 'order', record.orderId), makeEvent({
        id: keyedEventId('dstate', `dstate-${tenantId}-${record.orderId}-${record.event}-${record.at}`),
        type: 'DeliveryStateChanged',
        occurredAt: record.at,
        idempotencyKey: `dstate-${tenantId}-${record.orderId}-${record.event}-${record.at}`,
        source: 'api/fulfilment',
        payload: record,
      }));
    },
  };
}

/**
 * Dispatch-plan store (M19-FR-03/04). One stream per run date holds the planned routes as an append-only
 * `DispatchPlanned` fact; the latest plan/reassign wins. This is what feeds `reconcileRun` the order ids a
 * run is answerable for (the `assigned` list it never had) — plus the read for the dispatcher's own screen.
 */
/**
 * Notification delivery queue store (M31-FR-04). Each enqueue / delivery / failure / dead-letter is an
 * append-only `NotificationQueue` fact on one stream; the current queue is the tested `@sre/notifications`
 * engine replayed over them — the retry-then-dead-letter state machine runs once, in the fold, and a
 * dead-lettered send is kept, never dropped (hard rule #6).
 */
export function notificationQueueAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /** The delivery transport — absent in production until a real provider is certified (SMS is R4, OB-29). */
  readonly transport?: NotificationTransport;
  /** PF-10 r6: the providers' delivery-report secrets (from the API's environment). */
  readonly deliveryReportSecrets?: ReadonlyMap<string, string>;
}): NotificationQueueDeps {
  const stream = streamName(STREAM.org, 'notifications');
  return {
    now: input.now,
    ...(input.deliveryReportSecrets === undefined ? {} : { deliveryReportSecrets: input.deliveryReportSecrets }),
    isProviderRelay: async (tenantId, userId) => (await effectiveGrants(input.store, tenantId)).some((g) => g.userId === userId && g.roleId === PROVIDER_RELAY_ROLE_ID),
    queue: async (tenantId) => replayNotificationQueue(await allOf<NotificationQueueEvent>(input.store, tenantId, stream, 'NotificationQueue')),
    events: (tenantId) => allOf<NotificationQueueEvent>(input.store, tenantId, stream, 'NotificationQueue'),
    // PA-08: head office's own message-template register (drafted by one person, approved by another) and the SAME
    // consent ledger the rest of the system reads (P-02).
    templates: (tenantId) => allOf<MessageTemplateVersion>(input.store, tenantId, streamName(STREAM.org, 'message-templates'), 'MessageTemplateVersion'),
    recordTemplate: async (tenantId, v) => {
      await input.store.append(tenantId, streamName(STREAM.org, 'message-templates'), makeEvent({
        id: `msg-template-${v.templateId}-v${v.version}-${v.state}`, type: 'MessageTemplateVersion', occurredAt: v.withdrawnAt ?? v.approvedAt ?? v.draftedAt,
        idempotencyKey: `msg-template-${tenantId}-${v.templateId}-v${v.version}-${v.state}`, source: 'api/customer', payload: v,
      }));
    },
    consentRecords: (tenantId, customerId) => allOf<ConsentRecord>(input.store, tenantId, forCustomer(customerId), 'ConsentRecorded'),
    // PA-08 r6: the recipient still stands on their own — not erased (privacy tombstone), not merged into another record.
    recipient: (tenantId, customerId) => recipientStanding(input.store, tenantId, customerId),
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    // PA-08 round 4: the owner's messaging budget — a new version each change, the newest in force.
    budget: (tenantId) => latest<MessagingBudget>(input.store, tenantId, streamName(STREAM.org, 'messaging-budget'), 'MessagingBudgetSet'),
    recordBudget: async (tenantId, b) => {
      await input.store.append(tenantId, streamName(STREAM.org, 'messaging-budget'), makeEvent({
        id: `msg-budget-v${b.version}`, type: 'MessagingBudgetSet', occurredAt: b.setAt,
        idempotencyKey: `msg-budget-${tenantId}-v${b.version}`, source: 'api/customer', payload: b,
      }));
    },
    record: async (tenantId, event, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, stream, makeEvent({
        id: `notif-${event.change}-${event.id}-${d}`,
        type: 'NotificationQueue',
        occurredAt: event.at,
        idempotencyKey: `notif-${tenantId}-${event.change}-${event.id}-${d}`,
        source: 'api/customer',
        payload: event,
      }));
    },
  };
}

/**
 * PA-08 r6: whether a message recipient still stands on their own — read from head office's own records: a customer who
 * exercised their right to erasure (a sealed privacy tombstone), or a record merged into another (the merge approved and
 * not reversed; each stage its own fact, the latest per merge in force).
 */
export async function recipientStanding(store: EventStore, tenantId: string, customerId: string): Promise<RecipientStanding> {
  const erased = (await allOf<PrivacyTombstone>(store, tenantId, TOMBSTONE_STREAM, 'PrivacyTombstoneSealed')).find((t) => t.customerRef === customerId);
  if (erased !== undefined) return { allowed: false, reason: 'erased', detail: `${customerId} was erased at their own request (right to erasure) — they are not messaged again` };
  const merges = new Map<string, CustomerMerge>();
  for (const m of await allOf<CustomerMerge>(store, tenantId, streamName(STREAM.customer, 'merges'), 'CustomerMergeRecorded')) merges.set(m.mergeId, m);
  const absorbed = [...merges.values()].find((m) => m.mergedRef === customerId && m.approvedBy !== undefined && m.reversedBy === undefined);
  if (absorbed !== undefined) return { allowed: false, reason: 'merged_away', detail: `${customerId} was merged into ${absorbed.survivorRef} (${absorbed.mergeId}) — the record no longer stands on its own` };
  return { allowed: true };
}

export function dispatchAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DispatchDeps {
  const streamFor = (runDate: string) => streamName(STREAM.delivery, 'dispatch', runDate);
  return {
    now: input.now,
    plan: async (tenantId, runDate) => {
      const plans = await allOf<DispatchPlan>(input.store, tenantId, streamFor(runDate), 'DispatchPlanned');
      return plans[plans.length - 1]; // latest wins
    },
    recordPlan: async (tenantId, runDate, plan, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, streamFor(runDate), makeEvent({
        id: `dispatch-${runDate}-${d}`,
        type: 'DispatchPlanned',
        occurredAt: input.now(),
        idempotencyKey: `dispatch-${tenantId}-${runDate}-${d}`,
        source: 'api/fulfilment',
        payload: plan,
      }));
    },
  };
}

/**
 * Packing & dispatch store (M19-FR-02). One stream per order for its pack (latest wins — a re-pack
 * supersedes), one for its manifest. The pack is recorded so dispatch builds the manifest from what
 * was PACKED, never from what the caller re-supplies.
 */
/**
 * The picker handheld's wave register (SP-3c-i · F11's picker half · M19-FR-01/02). One stream per wave holds every line
 * outcome the handheld relayed (append-only history — a line picked and then rejected is two facts) and the wave's pack.
 * The picker / packer are re-verified from THEIR grants by the route; this only keeps and reads the records.
 */
export function fulfilmentWaveAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<WaveSyncDeps, 'recordAudit'> {
  const forWave = (waveId: string): string => streamName(STREAM.delivery, 'wave', waveId);
  const products = productMasterAdapter(input);
  const packs = fulfilmentPackingAdapter(input);
  return {
    now: input.now,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    lineOutcomes: (tenantId, waveId) => allOf<WaveLineOutcome>(input.store, tenantId, forWave(waveId), 'PickLineOutcomeRecorded'),
    recordLineOutcome: async (tenantId, o) => {
      await input.store.append(tenantId, forWave(o.waveId), makeEvent({
        id: `wave-line-${o.waveId}-${o.lineId}-${o.state}`,
        type: 'PickLineOutcomeRecorded',
        occurredAt: o.at,
        idempotencyKey: `wave-line-${tenantId}-${o.waveId}-${o.lineId}-${o.state}`,
        source: 'api/fulfilment',
        payload: o,
      }));
    },
    pack: async (tenantId, waveId) => {
      const all = await allOf<WavePackRecord>(input.store, tenantId, forWave(waveId), 'WavePackRecorded');
      return all[0]; // a wave packs once; the first record is the record
    },
    recordPack: async (tenantId, r) => {
      await input.store.append(tenantId, forWave(r.waveId), makeEvent({
        id: `wave-pack-${r.waveId}`,
        type: 'WavePackRecorded',
        occurredAt: r.at,
        idempotencyKey: `wave-pack-${tenantId}-${r.waveId}`,
        source: 'api/fulfilment',
        payload: r,
      }));
    },
    // M19-FR-02 fold: the product master's handling class, and the SAME per-order pack register the desk's pack route
    // writes and dispatch reads — one record per (order, pack digest), so a retried or restarted fold writes nothing twice.
    productPacking: async (tenantId, productId) => {
      const p = await products.product(tenantId, productId);
      return p === undefined ? undefined : { ...(p.handling === undefined ? {} : { handling: p.handling }), ...(p.coldChain === undefined ? {} : { coldChain: p.coldChain }) };
    },
    orderPack: (tenantId, orderId) => packs.pack(tenantId, orderId),
    recordOrderPack: (tenantId, orderId, result, key) => packs.recordPack(tenantId, orderId, result, key),
  };
}

/**
 * The driver handheld's route register (SP-3c-ii · F11's driver half · M19-FR-03/04 · M23). One stream per route holds every
 * stop outcome the phone relayed (append-only history — a stop that failed, was reattempted and delivered is three facts),
 * the end-of-shift settlement and the counted cash handover. The order's own lifecycle is the fulfilment adapter's register,
 * so the dispatcher's "where is it" and the driver's phone agree on one record. The driver is re-verified by the route.
 */
export function driverRunAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<SyncedDriverRunDeps, 'recordAudit'> {
  const forRoute = (routeId: string): string => streamName(STREAM.delivery, 'route', routeId);
  const orders = fulfilmentAdapter(input);
  return {
    now: input.now,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    stopUpdates: (tenantId, routeId) => allOf<RouteStopUpdate>(input.store, tenantId, forRoute(routeId), 'RouteStopUpdateRecorded'),
    recordStopUpdate: async (tenantId, u) => {
      await input.store.append(tenantId, forRoute(u.routeId), makeEvent({
        id: `route-stop-${u.routeId}-${u.stopId}-${u.state}`,
        type: 'RouteStopUpdateRecorded',
        occurredAt: u.at,
        idempotencyKey: `route-stop-${tenantId}-${u.routeId}-${u.stopId}-${u.state}`,
        source: 'api/fulfilment',
        payload: u,
      }));
    },
    settlement: async (tenantId, routeId) => (await allOf<RouteSettlementRecord>(input.store, tenantId, forRoute(routeId), 'RouteSettlementRecorded'))[0],
    recordSettlement: async (tenantId, r) => {
      await input.store.append(tenantId, forRoute(r.routeId), makeEvent({
        id: `route-settled-${r.routeId}`,
        type: 'RouteSettlementRecorded',
        occurredAt: r.at,
        idempotencyKey: `route-settled-${tenantId}-${r.routeId}`,
        source: 'api/fulfilment',
        payload: r,
      }));
    },
    handover: async (tenantId, routeId) => (await allOf<CashHandoverRecord>(input.store, tenantId, forRoute(routeId), 'DriverCashHandoverRecorded'))[0],
    recordHandover: async (tenantId, r) => {
      await input.store.append(tenantId, forRoute(r.routeId), makeEvent({
        id: `route-handover-${r.routeId}`,
        type: 'DriverCashHandoverRecorded',
        occurredAt: r.at,
        idempotencyKey: `route-handover-${tenantId}-${r.routeId}`,
        source: 'api/fulfilment',
        payload: r,
      }));
    },
    deliveryState: orders.deliveryState,
    recordDeliveryTransition: orders.recordDeliveryTransition,
    // OB-09: the phone's door outcomes join the driver's own run register — the stream `/v1/delivery/runs/:driverId` reads.
    recordAttempt: orders.appendAttempt,
  };
}

/**
 * Round 15 (verifier GAP A): which store head office ASSIGNED each wave and route at — one tenant-wide index, written in the
 * SAME batch as the assignment itself, so the relay judge (`relay-record-store.ts`) reads the store of a head-office wave or
 * route from head office's own record, never from whichever store computer relays it first. Append-only; one entry per
 * (wave or route, store). Assignments made before this index existed are found by reading each known store's own stream.
 */
export interface AssignmentPlaced { readonly kind: 'wave' | 'route'; readonly id: string; readonly storeId: string; readonly at: string }
function assignmentPlacedEntry(tenantId: string, kind: 'wave' | 'route', id: string, storeId: string, at: string): { stream: string; event: DomainEvent } {
  return {
    stream: streamName(STREAM.delivery, 'assignment-index'),
    event: makeEvent({
      id: `assignment-placed-${kind}-${id}-${storeId}`, type: 'AssignmentPlaced', occurredAt: at,
      idempotencyKey: `assignment-placed-${tenantId}-${kind}-${id}-${storeId}`, source: 'api/fulfilment',
      payload: { kind, id, storeId, at } satisfies AssignmentPlaced,
    }),
  };
}

/** The stores head office assigned a wave (or route) at: the index, plus — for assignments made before it — each known store's stream. */
export async function assignedStoresOf(input: { readonly store: EventStore }, tenantId: string, kind: 'wave' | 'route', id: string, knownStores: Iterable<string>): Promise<readonly string[]> {
  const out = new Set<string>();
  for (const p of await allOf<AssignmentPlaced>(input.store, tenantId, streamName(STREAM.delivery, 'assignment-index'), 'AssignmentPlaced')) {
    if (p.kind === kind && p.id === id) out.add(p.storeId);
  }
  for (const storeId of knownStores) {
    if (out.has(storeId)) continue;
    const stream = streamName(STREAM.delivery, 'assignments', storeId);
    const held = kind === 'wave'
      ? (await allOf<WaveAssignment>(input.store, tenantId, stream, 'WaveAssigned')).some((a) => a.waveId === id)
      : (await allOf<RouteAssignment>(input.store, tenantId, stream, 'RouteAssigned')).some((a) => a.routeId === id);
    if (held) out.add(storeId);
  }
  return [...out];
}

/**
 * Head office's assignments of waves to pickers and routes to drivers, per store (HA-1 · M19-FR-01/03). One stream per store
 * holds every assignment as an append-only fact (`WaveAssigned` / `RouteAssigned`, keyed on the wave or route and the content
 * digest, so the same assignment posted twice is one record and a changed one is a new record that replaces it). "Done" is
 * read from the registers that already exist: a wave with a pack on the wave register, a route with a settlement on the route
 * register.
 */
export function assignmentsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Omit<AssignmentsDeps, 'recordAudit'> {
  const forStore = (storeId: string): string => streamName(STREAM.delivery, 'assignments', storeId);
  const waves = fulfilmentWaveAdapter(input);
  const runs = driverRunAdapter(input);
  return {
    now: input.now,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    waveAssignments: (tenantId, storeId) => allOf<WaveAssignment>(input.store, tenantId, forStore(storeId), 'WaveAssigned'),
    recordWaveAssignment: async (tenantId, a) => {
      await input.store.appendBatch(tenantId, [{ stream: forStore(a.storeId), event: makeEvent({
        id: `wave-assigned-${a.waveId}-${a.digest}`,
        type: 'WaveAssigned',
        occurredAt: a.at,
        idempotencyKey: `wave-assigned-${tenantId}-${a.storeId}-${a.waveId}-${a.digest}`,
        source: 'api/fulfilment',
        payload: a,
      }) }, assignmentPlacedEntry(tenantId, 'wave', a.waveId, a.storeId, a.at)]);
    },
    routeAssignments: (tenantId, storeId) => allOf<RouteAssignment>(input.store, tenantId, forStore(storeId), 'RouteAssigned'),
    recordRouteAssignment: async (tenantId, a) => {
      await input.store.appendBatch(tenantId, [{ stream: forStore(a.storeId), event: makeEvent({
        id: `route-assigned-${a.routeId}-${a.digest}`,
        type: 'RouteAssigned',
        occurredAt: a.at,
        idempotencyKey: `route-assigned-${tenantId}-${a.storeId}-${a.routeId}-${a.digest}`,
        source: 'api/fulfilment',
        payload: a,
      }) }, assignmentPlacedEntry(tenantId, 'route', a.routeId, a.storeId, a.at)]);
    },
    wavePacked: async (tenantId, waveId) => (await waves.pack(tenantId, waveId)) !== undefined,
    routeSettled: async (tenantId, routeId) => (await runs.settlement(tenantId, routeId)) !== undefined,
  };
}

/**
 * FUL-14: the stored truth a substitution is decided from — the catalogue's price, the product master's attributes, the
 * order's payment, the customer's rules (on the order, else standing) and the consents recorded per order.
 */
export function substitutionTruthAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly orders: Pick<OrdersDeps, 'orderPayment' | 'paymentResolution'> & { readonly placedOrder: (tenantId: string, orderId: string) => Promise<PlacedOrder | undefined> | PlacedOrder | undefined };
  readonly approvals?: ApprovalPort;
}): SubstitutionTruthDeps {
  const forOrderSubs = (orderId: string): string => streamName(STREAM.orders, 'substitution-truth', orderId);
  const forCustomerRules = (customerRef: string): string => streamName(STREAM.orders, 'substitution-rules', customerRef);
  const pos = posAdapter(input);
  const master = productMasterAdapter(input);
  return {
    ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
    product: async (tenantId, productId) => {
      const [published, record] = await Promise.all([pos.catalogue(tenantId), master.product(tenantId, productId)]);
      const p = published.get(productId);
      if (p === undefined && record === undefined) return undefined;
      return {
        name: record?.name ?? p?.name,
        ...(p === undefined ? {} : { unitPriceMinor: p.unitPriceMinor }),
        ...(record === undefined ? {} : { attrs: {
          productId, name: record.name,
          ...(record.brand === undefined ? {} : { brand: record.brand }),
          ...(record.primaryCategoryId === null ? {} : { categoryId: record.primaryCategoryId }),
          // An allergen declaration only when one was made: `undefined` is "nobody has said", never "none".
          ...(record.safety?.allergens === undefined ? {} : { allergens: record.safety.allergens.map((a) => a.trim().toLowerCase()) }),
          ageRestricted: record.safety?.minimumAge !== undefined,
        } }),
      };
    },
    rulesFor: async (tenantId, orderId) => {
      const own = await latest<StoredSubstitutionRules>(input.store, tenantId, forOrderSubs(orderId), 'OrderSubstitutionRulesRecorded');
      if (own !== undefined) return own;
      const placed = await input.orders.placedOrder(tenantId, orderId);
      return placed?.customerRef === undefined ? undefined
        : latest<StoredSubstitutionRules>(input.store, tenantId, forCustomerRules(placed.customerRef), 'CustomerSubstitutionRulesRecorded');
    },
    tenderOf: async (tenantId, orderId) => {
      const pay = paymentPosition(await input.orders.orderPayment?.(tenantId, orderId), await input.orders.paymentResolution?.(tenantId, orderId));
      if (pay.state === 'authorised') return 'prepaid';
      return (await input.orders.placedOrder(tenantId, orderId))?.fulfilment === 'pickup' ? 'pay_at_store' : 'cod';
    },
    consents: (tenantId, orderId) => allOf<SubstitutionConsent>(input.store, tenantId, forOrderSubs(orderId), 'SubstitutionConsentRecorded'),
    recordConsent: async (tenantId, c) => {
      await input.store.append(tenantId, forOrderSubs(c.orderId), makeEvent({
        id: keyedEventId('sub-consent', `sub-consent-${tenantId}-${c.orderId}-${c.lineId}-${c.substituteProductId}-${c.given}-${c.at}`), type: 'SubstitutionConsentRecorded', occurredAt: c.at,
        idempotencyKey: `sub-consent-${tenantId}-${c.orderId}-${c.lineId}-${c.substituteProductId}-${c.given}-${c.at}`, source: 'api/orders', payload: c,
      }));
    },
    recordOrderRules: async (tenantId, orderId, r) => {
      await input.store.append(tenantId, forOrderSubs(orderId), makeEvent({
        id: keyedEventId('sub-rules', `sub-rules-${tenantId}-${orderId}-${r.at}`), type: 'OrderSubstitutionRulesRecorded', occurredAt: r.at,
        idempotencyKey: `sub-rules-${tenantId}-${orderId}-${r.at}`, source: 'api/orders', payload: r,
      }));
    },
    recordCustomerRules: async (tenantId, customerRef, r) => {
      await input.store.append(tenantId, forCustomerRules(customerRef), makeEvent({
        id: keyedEventId('cust-sub-rules', `cust-sub-rules-${tenantId}-${customerRef}-${r.at}`), type: 'CustomerSubstitutionRulesRecorded', occurredAt: r.at,
        idempotencyKey: `cust-sub-rules-${tenantId}-${customerRef}-${r.at}`, source: 'api/orders', payload: r,
      }));
    },
  };
}

/**
 * FUL-05: the one fulfilment command's own records — the counted hand-back and the settlement, one stream per order — and its
 * reads of the pack, the manifest, the door, the order and its money, the sale pipeline it banks through and the product unit.
 */
export function orderFulfilmentAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly holdMinutes: number;
  readonly refundProcessor: Parameters<typeof ordersAdapter>[0]['refundProcessor'];
}): OrderFulfilmentDeps {
  const forOrder = (orderId: string): string => streamName(STREAM.delivery, 'fulfilment', orderId);
  const orders = ordersAdapter({ store: input.store, now: input.now, holdMinutes: input.holdMinutes, refundProcessor: input.refundProcessor });
  const packing = fulfilmentPackingAdapter(input);
  const delivery = fulfilmentAdapter(input);
  const pos = posAdapter(input);
  return {
    now: input.now,
    orderState: orders.orderState, recordTransition: orders.recordTransition,
    orderReservations: orders.orderReservations, releaseReservations: orders.releaseReservations,
    orderPayment: orders.orderPayment, paymentResolution: orders.paymentResolution, orderRefunds: orders.orderRefunds,
    pack: packing.pack, manifest: packing.manifest, deliveryState: delivery.deliveryState,
    doorAttempts: (tenantId, orderId) => orderAttemptsOf(input.store, tenantId, orderId),
    isBanked: pos.isBanked, bankSale: pos.bankSale,
    // OB-31: the product's unit in its one spelling ('each' → 'ea', 'KG' → 'kg').
    uomOf: async (tenantId, productId) => {
      const unit = (await pos.catalogue(tenantId)).get(productId)?.baseUom;
      return unit === undefined ? undefined : normaliseUom(unit) ?? unit;
    },
    handback: async (tenantId, orderId) => (await allOf<OrderHandback>(input.store, tenantId, forOrder(orderId), 'OrderHandbackCounted'))[0],
    recordHandback: async (tenantId, h) => {
      await input.store.append(tenantId, forOrder(h.orderId), makeEvent({
        id: `order-handback-${h.orderId}`, type: 'OrderHandbackCounted', occurredAt: h.at,
        idempotencyKey: `order-handback-${tenantId}-${h.orderId}`, source: 'api/fulfilment', payload: h,
      }));
    },
    settlement: async (tenantId, orderId) => (await allOf<FulfilmentSettlement>(input.store, tenantId, forOrder(orderId), 'OrderFulfilmentSettled'))[0],
    recordSettlement: async (tenantId, st) => {
      await input.store.append(tenantId, forOrder(st.orderId), makeEvent({
        id: `order-settled-${st.orderId}`, type: 'OrderFulfilmentSettled', occurredAt: st.at,
        // One settlement per order: a second run collapses on this key (hard rule #2).
        idempotencyKey: `order-settled-${tenantId}-${st.orderId}`, source: 'api/fulfilment', payload: st,
      }));
    },
  };
}

export function fulfilmentPackingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FulfilmentPackingDeps {
  const latestPack = async (tenantId: string, orderId: string): Promise<PackResult | undefined> => {
    const all = await allOf<PackResult>(input.store, tenantId, forOrderPack(orderId), 'OrderPacked');
    return all[all.length - 1]; // occurrence order → the last pack wins
  };
  const latestManifest = async (tenantId: string, orderId: string): Promise<Manifest | undefined> => {
    const all = await allOf<Manifest>(input.store, tenantId, forOrderManifest(orderId), 'OrderDispatched');
    return all[all.length - 1];
  };
  return {
    now: input.now,
    // FUL-04: the order from head office's order register, the packing policy from the product master (the same fold the
    // wave adapter reads), the name and price from the published catalogue and the unit from the master — never the body.
    order: async (tenantId, orderId) => {
      const view = await ordersAdapter({ store: input.store, now: input.now, holdMinutes: 0 }).orderState(tenantId, orderId);
      return view === undefined ? undefined : { state: view.state, lines: view.lines };
    },
    productPacking: async (tenantId, productId) => {
      const p = await productMasterAdapter(input).product(tenantId, productId);
      return p === undefined ? undefined : { ...(p.handling === undefined ? {} : { handling: p.handling }), ...(p.coldChain === undefined ? {} : { coldChain: p.coldChain }) };
    },
    productFacts: async (tenantId, productId) => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      const p = pack?.snapshot.products.find((x) => x.productId === productId);
      if (p === undefined) return undefined;
      const uom = (await productUomFrom(input, tenantId, productId)) ?? p.baseUom ?? 'ea';
      return { name: p.name, unitPriceMinor: p.unitPriceMinor, uom };
    },
    pack: (tenantId, orderId) => latestPack(tenantId, orderId),
    manifest: (tenantId, orderId) => latestManifest(tenantId, orderId),
    recordPack: async (tenantId, orderId, result, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, forOrderPack(orderId), makeEvent({
        id: `order-pack-${orderId}-${d}`,
        type: 'OrderPacked',
        occurredAt: input.now(),
        idempotencyKey: `order-pack-${tenantId}-${orderId}-${d}`,
        source: 'api/fulfilment',
        payload: result as unknown as Record<string, unknown>,
      }));
    },
    recordDispatch: async (tenantId, orderId, manifest, key) => {
      await input.store.append(tenantId, forOrderManifest(orderId), makeEvent({
        id: `order-manifest-${orderId}-${key}`,
        type: 'OrderDispatched',
        occurredAt: input.now(),
        // Keyed on the manifest id — a re-sent dispatch of the same manifest collapses (hard rule #2).
        idempotencyKey: `order-manifest-${tenantId}-${orderId}-${key}`,
        source: 'api/fulfilment',
        payload: manifest as unknown as Record<string, unknown>,
      }));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The last five: identity, platform, reporting, migration, AI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token revocations, durably (GAP-SEC-05): each is one append-only `TokenRevoked` fact on the tenant's identity
 * stream — never edited, never removed (hard rule #2/#6) — folded back into the list the authenticator consults.
 */
export function tokenRevocationAdapter(input: { readonly store: EventStore }): TokenRevocationStore {
  return {
    load: (tenantId) => allOf<TokenRevocation>(input.store, tenantId, STREAM.identity, 'TokenRevoked'),
    record: async (tenantId, revocation) => {
      await input.store.append(tenantId, STREAM.identity, makeEvent({
        id: `token-revocation-${revocation.id}`,
        type: 'TokenRevoked',
        occurredAt: revocation.revokedAt,
        idempotencyKey: `token-revocation-${tenantId}-${revocation.id}`,
        source: 'api/identity',
        payload: revocation,
      }));
    },
  };
}

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
    effectiveGrants(input.store, tenantId);
  const numberSeries = input.numberSeries ?? new InMemoryNumberSeriesStore();

  return {
    now: input.now,
    roles: () => input.roleCatalogue,
    allocateNumber: (tenantId, docType) => numberSeries.allocate(tenantId, docType),

    // PA-12 round 10: the roles a user holds now (grants minus revocations, plus a live emergency grant) — never the request.
    rolesHeldBy: (tenantId, userId) => rolesHeldNow(input.store, tenantId, userId, input.now()),
    isPerson: (tenantId, userId) => isPersonNow(input.store, tenantId, userId),
    outsideLoginOf: (tenantId, userId) => outsideLoginOf(input.store, tenantId, userId, input.now()),
    /** Every permission from every role this user holds. Union, deduplicated, sorted. */
    permissionsOf: async (tenantId, userId) => {
      const held = (await assignments(tenantId)).filter((a) => a.userId === userId);
      const codes = held.flatMap((a) =>
        input.roleCatalogue.find((r) => r.id === a.roleId)?.permissions ?? []);
      return [...new Set(codes)].sort();
    },

    // Grant requests and what became of them (Wave 2b · PA-03): asked (RoleGrantRequested), then granted (the RoleGranted
    // that carries the same grantId) or rejected (RoleGrantRejected) — one fold, in append order.
    grantRequests: async (tenantId) => {
      const events = await input.store.readStream(tenantId, STREAM.identity);
      const byId = new Map<string, GrantRequestRecord>();
      for (const e of events) {
        if (e.event.type === 'RoleGrantRequested') {
          const r = payloadOf<PendingGrantRequest>(e);
          byId.set(r.grantId, { ...r, state: 'pending' });
        } else if (e.event.type === ROLE_GRANTED) {
          const g = payloadOf<{ request?: { grantId?: string; approvedBy?: string } }>(e);
          const id = g.request?.grantId;
          const r = id === undefined ? undefined : byId.get(id);
          if (id !== undefined && r !== undefined) byId.set(id, { ...r, state: 'granted', decidedBy: g.request?.approvedBy ?? '', decidedAt: e.event.occurredAt });
        } else if (e.event.type === 'RoleGrantRejected') {
          const x = payloadOf<GrantRejection>(e);
          const r = byId.get(x.grantId);
          if (r !== undefined) byId.set(x.grantId, { ...r, state: 'rejected', decidedBy: x.rejectedBy, decidedAt: x.at });
        }
      }
      return [...byId.values()];
    },
    recordGrantRequest: async (tenantId, request) => {
      await input.store.append(tenantId, STREAM.identity, makeEvent({
        id: `grant-request-${request.grantId}`,
        type: 'RoleGrantRequested',
        occurredAt: request.requestedAt,
        idempotencyKey: `grant-request-${tenantId}-${request.grantId}`,
        source: 'api/identity',
        payload: request,
      }));
    },
    recordGrantRejection: async (tenantId, rejection) => {
      await input.store.append(tenantId, STREAM.identity, makeEvent({
        id: `grant-rejection-${rejection.grantId}`,
        type: 'RoleGrantRejected',
        occurredAt: rejection.at,
        idempotencyKey: `grant-rejection-${tenantId}-${rejection.grantId}`,
        source: 'api/identity',
        payload: rejection,
      }));
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

    // SF-01: the change AND its operative store-scope price-list entries, effective from today, in ONE append — the
    // price the catalogue pack resolves per store is now the one the screen saved (before, only the record was kept and
    // the list the pack reads never moved). Each entry takes the next version for its (store, product), as the list
    // route numbers them, so the change supersedes whatever stood before.
    recordPriceChange: async (tenantId, change: PriceChangeRecord, storeIds) => {
      const existing = await allOf<PriceEntry>(input.store, tenantId, forPriceList(change.productId), 'PriceListEntryPublished');
      const effectiveFrom = change.at.slice(0, 10);
      await input.store.appendBatch(tenantId, [
        {
          stream: STREAM.pricing,
          event: makeEvent({
            id: keyedEventId('pricechange', `pricechange-${tenantId}-${change.productId}-${change.at}`),
            type: 'PriceChangeRecorded',
            occurredAt: change.at,
            idempotencyKey: `pricechange-${tenantId}-${change.productId}-${change.at}`,
            source: 'api/pricing',
            payload: { ...change, operativeAt: storeIds },
          }),
        },
        ...storeIds.map((storeId) => {
          const version = existing.filter((e) => e.scope === 'store' && e.scopeRef === storeId).reduce((max, e) => Math.max(max, e.version), 0) + 1;
          const entry: PriceEntry = {
            id: `change-${change.at}-${storeId}`, productId: change.productId, scope: 'store', scopeRef: storeId,
            price: money(change.priceMinor, change.currency as CurrencyCode), effectiveFrom, effectiveTo: null, status: 'active', version,
          };
          return {
            stream: forPriceList(change.productId),
            event: makeEvent({
              id: `price-entry-${change.productId}-${entry.id}`,
              type: 'PriceListEntryPublished',
              occurredAt: change.at,
              idempotencyKey: `price-entry-${tenantId}-${change.productId}-${entry.id}`,
              source: 'api/pricing',
              payload: entry,
            }),
          };
        }),
      ]);
    },

    // SF-01: the stores a head-office price applies to — every branch head office runs, and every store a catalogue
    // pack has been published for (a store set up before the org structure is still a store whose lanes sell).
    storesToPrice: async (tenantId) => {
      const branches = (await orgStructureAdapter(input).nodes(tenantId)).filter((n) => n.kind === 'branch' && n.status !== 'closed').map((n) => n.nodeId);
      const packs = (await allOf<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished')).map((p) => p.snapshot.scope?.storeId).filter((x): x is string => typeof x === 'string' && x !== '');
      return [...new Set([...branches, ...packs])];
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
      // SF-01: the launch and the switch-on are ONE append — the rule the lanes read becomes active exactly when the
      // governed launch lands, never one without the other. The activation carries the same key `/activate` uses, so
      // either path collapses into one switch-on.
      await input.store.appendBatch(tenantId, [
        { stream: STREAM.promotions, event: makeEvent({
          id: `promo-launch-${record.promotionId}`,
          type: 'PromotionLaunched',
          occurredAt: record.launchedAt,
          // The promotion's own id, no timestamp — re-launching the same one collapses rather than
          // recording a second launch of an offer that is already live.
          idempotencyKey: `promo-launch-${tenantId}-${record.promotionId}`,
          source: 'api/pricing',
          payload: record,
        }) },
        { stream: STREAM.promotions, event: makeEvent({
          id: `promo-active-${record.promotionId}`,
          type: 'PromotionActivated',
          occurredAt: record.launchedAt,
          idempotencyKey: `promo-active-${tenantId}-${record.promotionId}`,
          source: 'api/pricing',
          payload: { promotionId: record.promotionId },
        }) },
      ]);
    },

    definedPromotion: (tenantId, promotionId) => promotionCatalogueAdapter(input).promotion(tenantId, promotionId),
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

    launched: async (tenantId, promotionId) =>
      (await allOf<LaunchRecord>(input.store, tenantId, STREAM.promotions, 'PromotionLaunched')).some((r) => r.promotionId === promotionId),

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

/**
 * Durable device registry (M33-FR-02/04) — the shop's real fleet, event-sourced on a devices sub-stream
 * of the platform stream and folded latest-per-deviceId, so `fleet` survives a restart.
 */
export function deviceRegistryAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DeviceRegistryDeps {
  const stream = streamName(STREAM.platform, 'devices');
  const policyStream = streamName(STREAM.platform, 'version-policy');
  return {
    now: input.now,
    fleet: async (tenantId) => projectFleet(tenantId, await allOf<DeviceRegistryEvent>(input.store, tenantId, stream, 'DeviceRegistryEvent')),
    // fleet-health falls back to the STORED version policy when the caller does not supply one, so a durable
    // remote kill (set on the version-policy sub-stream) actually takes effect on the health read.
    storedPolicy: async (tenantId) => projectVersionPolicy(await allOf<VersionPolicyEvent>(input.store, tenantId, policyStream, 'VersionPolicyEvent')),
    recordDeviceEvent: async (tenantId, event, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `device-${event.deviceId}-${event.kind}-${key}`,
        type: 'DeviceRegistryEvent',
        occurredAt: event.at,
        // Keyed per intent: a re-sync of the same command collapses; a genuine later change is a new key
        // and stays alongside the earlier one (append-only, hard rule #2).
        idempotencyKey: `device-${tenantId}-${key}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

/**
 * The durable version-policy store (M33 remote kill). Reads/writes a `version-policy` sub-stream of the
 * platform stream, folded latest-set-wins, so the policy an admin sets survives a restart and is what the
 * fleet is judged against.
 */
export function versionPolicyAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): VersionPolicyDeps {
  const stream = streamName(STREAM.platform, 'version-policy');
  return {
    now: input.now,
    policy: async (tenantId) => projectVersionPolicy(await allOf<VersionPolicyEvent>(input.store, tenantId, stream, 'VersionPolicyEvent')),
    recordPolicyEvent: async (tenantId, event, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `version-policy-${key}`,
        type: 'VersionPolicyEvent',
        occurredAt: event.at,
        idempotencyKey: `version-policy-${tenantId}-${key}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

/**
 * The durable partner-credential registry (M36-FR-04). Each credential lives on its own append-only
 * sub-stream, folded latest-wins, so register and revoke are both versions and the history stays
 * (hard rule #6). The access-check reads the current version as the authoritative security principal.
 */
export function partnerAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PartnerDeps {
  const streamFor = (credentialId: string): string => streamName(STREAM.platform, 'partner', credentialId);
  return {
    now: input.now,
    credential: async (tenantId, credentialId) =>
      latest<PartnerCredential>(input.store, tenantId, streamFor(credentialId), 'PartnerCredentialSet'),
    recordCredential: async (tenantId, credential, key) => {
      await input.store.append(tenantId, streamFor(credential.credentialId), makeEvent({
        id: `partner-cred-${credential.credentialId}-${key}`,
        type: 'PartnerCredentialSet',
        occurredAt: input.now(),
        idempotencyKey: `partner-cred-${tenantId}-${credential.credentialId}-${key}`,
        source: 'api/platform',
        payload: credential,
      }));
    },
    // A connector's certification, latest-wins on its own per-partner+connector sub-stream (a re-cert is a
    // new version; the history stays, hard rule #6). Keyed on the certification's tested versions + date so
    // a re-send of the same certification collapses while a genuine re-certification is a new fact.
    certification: async (tenantId, partnerId, connectorId) =>
      latest<Certification>(input.store, tenantId, streamName(STREAM.platform, 'partner-cert', partnerId, connectorId), 'PartnerCertificationSet'),
    recordCertification: async (tenantId, certification) => {
      const key = `${certification.certifiedOn}-${certification.againstVersions.map((v) => `${v.contract}:${v.version}`).join(',')}`;
      await input.store.append(tenantId, streamName(STREAM.platform, 'partner-cert', certification.partnerId, certification.connectorId), makeEvent({
        id: `partner-cert-${certification.certificationId}-${key}`,
        type: 'PartnerCertificationSet',
        occurredAt: input.now(),
        idempotencyKey: `partner-cert-${tenantId}-${certification.partnerId}-${certification.connectorId}-${key}`,
        source: 'api/platform',
        payload: certification,
      }));
    },
    // A registered sandbox tenant, latest-wins on its own id (a re-register with a new expiry is a new
    // version; the history stays, hard rule #6). A sandbox holds synthetic data only.
    sandbox: async (tenantId, sandboxId) =>
      latest<SandboxTenant>(input.store, tenantId, streamName(STREAM.platform, 'partner-sandbox', sandboxId), 'PartnerSandboxSet'),
    recordSandbox: async (tenantId, sandbox) => {
      const key = `${sandbox.createdOn}-${sandbox.expiresOn}`;
      await input.store.append(tenantId, streamName(STREAM.platform, 'partner-sandbox', sandbox.tenantId), makeEvent({
        id: `partner-sandbox-${sandbox.tenantId}-${key}`,
        type: 'PartnerSandboxSet',
        occurredAt: input.now(),
        idempotencyKey: `partner-sandbox-${tenantId}-${sandbox.tenantId}-${key}`,
        source: 'api/platform',
        payload: sandbox,
      }));
    },
  };
}

/**
 * The durable background-job registry (M33-FR-01). Reads/writes a `jobs` sub-stream of the platform stream,
 * folded latest-per-job, so a job scheduled/reported/retried survives a restart and a failed job stays
 * visible until a person acts on it (append-only, hard rule #2/#6).
 */
export function backgroundJobsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): BackgroundJobsDeps {
  const stream = streamName(STREAM.platform, 'jobs');
  return {
    now: input.now,
    jobs: async (tenantId) => projectJobs(await allOf<BackgroundJobEvent>(input.store, tenantId, stream, 'BackgroundJobEvent')),
    recordJobEvent: async (tenantId, event, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `job-${event.jobId}-${event.change}-${key}`,
        type: 'BackgroundJobEvent',
        occurredAt: event.at,
        idempotencyKey: `job-${tenantId}-${key}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

/**
 * The durable support-access lifecycle store (M33-FR-03 · SEC-11). Reads/writes a `support-access` sub-stream
 * of the platform stream, folded latest-per-request, so a request → owner-decision → session → actions → end
 * survives a restart and every support session is an entry that cannot be removed (append-only, hard rule #2/#6).
 */
export function supportAccessAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SupportAccessDeps {
  const stream = streamName(STREAM.platform, 'support-access');
  const idOf = (e: SupportAccessEvent): string => e.kind === 'requested' ? e.request.requestId : e.kind === 'decided' ? e.requestId : e.sessionId;
  const atOf = (e: SupportAccessEvent): string => e.kind === 'requested' ? e.request.at : e.kind === 'action' ? e.action.at : e.at;
  return {
    now: input.now,
    records: async (tenantId) => projectSupportAccess(await allOf<SupportAccessEvent>(input.store, tenantId, stream, 'SupportAccessLifecycleEvent')),
    recordEvent: async (tenantId, event, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `support-${idOf(event)}-${event.kind}-${key}`,
        type: 'SupportAccessLifecycleEvent',
        occurredAt: atOf(event),
        idempotencyKey: `support-${tenantId}-${key}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

/**
 * The status centre (M33-FR-04). Composes what the platform already knows — the device fleet judged against
 * the stored version policy, and how many support sessions are live now — for the `statusCentre` engine to
 * fold with the caller-supplied health evidence. Reads only; entitlement-expiry data is not stored yet, so
 * the expiring-entitlements list is empty (the remaining FR-04 gap).
 */
export function statusCentreAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): StatusCentreDeps {
  const deviceStream = streamName(STREAM.platform, 'devices');
  const policyStream = streamName(STREAM.platform, 'version-policy');
  const supportStream = streamName(STREAM.platform, 'support-access');
  return {
    now: input.now,
    fleet: async (tenantId) => {
      const devices = projectFleet(tenantId, await allOf<DeviceRegistryEvent>(input.store, tenantId, deviceStream, 'DeviceRegistryEvent'));
      const policy = projectVersionPolicy(await allOf<VersionPolicyEvent>(input.store, tenantId, policyStream, 'VersionPolicyEvent'));
      if (policy === undefined) {
        // No version policy yet: judge by registration status alone — a blocked/retired device is not trading.
        const trading = devices.filter((d) => d.status === 'registered').length;
        return { total: devices.length, trading, blocked: devices.length - trading };
      }
      const s = fleetSummary(devices, policy, input.now());
      return { total: s.total, trading: s.trading, blocked: s.blocked };
    },
    supportSessions: async (tenantId) =>
      projectSupportAccess(await allOf<SupportAccessEvent>(input.store, tenantId, supportStream, 'SupportAccessLifecycleEvent'))
        .filter((r) => r.session !== undefined)
        .map((r) => r.session!),
    // The real licences (M33-FR-04) — with their expiry — so the status centre's expiring-entitlements list is
    // live, not empty. Mapped to the engine's EntitlementState shape.
    entitlements: async (tenantId) =>
      projectLicences(await allOf<LicenceEvent>(input.store, tenantId, streamName(STREAM.platform, 'licences'), 'LicenceSet'))
        .map((l) => ({ tenantId, moduleId: l.moduleId, enabled: l.enabled, ...(l.expiresOn !== undefined ? { expiresOn: l.expiresOn } : {}) })),
  };
}

/**
 * The durable licence store (M33-FR-04). Reads/writes a `licences` sub-stream of the platform stream, folded
 * latest-per-module, so a licence's expiry and its named owner survive a restart and an expiring licence keeps
 * alerting until a person renews it (append-only, hard rule #2/#6).
 */
export function licencesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): LicenceDeps {
  const stream = streamName(STREAM.platform, 'licences');
  return {
    now: input.now,
    licences: async (tenantId) => projectLicences(await allOf<LicenceEvent>(input.store, tenantId, stream, 'LicenceSet')),
    recordLicence: async (tenantId, event, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `licence-${event.licence.moduleId}-${key}`,
        type: 'LicenceSet',
        occurredAt: event.at,
        idempotencyKey: `licence-${tenantId}-${key}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

/**
 * The durable platform service-request tracker (M33-FR-04). Reads/writes a `service-requests` sub-stream of
 * the platform stream, folded latest-per-request, so a request → assign → work → resolve survives a restart
 * and an open request stays visible until a person closes it (append-only, hard rule #2/#6).
 */
export function serviceRequestsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ServiceRequestsDeps {
  const stream = streamName(STREAM.platform, 'service-requests');
  return {
    now: input.now,
    requests: async (tenantId) => projectServiceRequests(await allOf<ServiceRequestEvent>(input.store, tenantId, stream, 'ServiceRequestEvent')),
    recordEvent: async (tenantId, event, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `svc-${event.requestId}-${event.change}-${key}`,
        type: 'ServiceRequestEvent',
        occurredAt: event.at,
        idempotencyKey: `svc-${tenantId}-${key}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

/**
 * The durable remote-session control store (M33-FR-02). Reads/writes a `remote-sessions` sub-stream of the
 * platform stream, folded latest-per-session, so a live remote/terminal session is visible and an
 * administrator's termination of it survives a restart (append-only, hard rule #2/#6).
 */
export function remoteSessionsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): RemoteSessionsDeps {
  const stream = streamName(STREAM.platform, 'remote-sessions');
  return {
    now: input.now,
    sessions: async (tenantId) => projectRemoteSessions(await allOf<RemoteSessionEvent>(input.store, tenantId, stream, 'RemoteSessionEvent')),
    recordEvent: async (tenantId, event, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `rsession-${event.sessionId}-${event.change}-${key}`,
        type: 'RemoteSessionEvent',
        occurredAt: event.at,
        idempotencyKey: `rsession-${tenantId}-${key}`,
        source: 'api/platform',
        payload: event,
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
        id: keyedEventId('flag', `flag-${tenantId}-${change.key}-${change.changedAt}`),
        type: 'FeatureFlagSet',
        occurredAt: change.changedAt,
        // Time is in the key: turning a flag off and back on again is two facts, and "who turned
        // this back on, and when" is the entire reason the record exists.
        idempotencyKey: `flag-${tenantId}-${change.key}-${change.changedAt}`,
        source: 'api/platform',
        payload: change,
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
        id: keyedEventId('entitlement', `entitlement-${tenantId}-${feature}-${at}`),
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
 * Subscription & recurring billing (WP5 / ADR-0014).
 *
 * Append-only on a dedicated billing sub-stream: subscribing, giving notice, and each charge are
 * immutable facts, and the current state is a fold (`foldBilling`), never an overwritten status
 * column (hard rule #2). The provider only sets up the mandate and reports charge outcomes; every
 * regulated rule — the schedule, the RBI ceilings, the GST invoice, the dunning ladder that suspends
 * optional features but never stops trading — is in the tested `packages/platform` engine. The
 * provider defaults to the sandbox: no real money can move until a live merchant account exists.
 */
export function billingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly provider: RecurringBillingProvider;
  readonly plans: readonly BillingPlan[];
  readonly policy?: DunningPolicy;
  readonly preDebitNoticeHours?: number;
}): BillingDeps {
  const policy: DunningPolicy = input.policy ?? { maxRetries: 3, suspendableGrants: [...OPTIONAL_FEATURES] };
  const noticeHours = input.preDebitNoticeHours ?? 24;
  const BILLING = PLATFORM_BILLING_STREAM;

  interface StartedPayload {
    readonly planId: string; readonly rail: BillingRail; readonly mandate: Mandate;
    readonly schedule: BillingSchedule; readonly startedOn: string; readonly by: string;
  }
  interface CancelledPayload { readonly endsOn: string; readonly by: string; readonly at: string }
  interface ChargePayload {
    readonly outcome: 'succeeded' | 'failed'; readonly chargeRef: string;
    readonly amountMinor: number; readonly at: string;
  }

  const readEvents = async (tenantId: string): Promise<readonly BillingEvent[]> => {
    const events = await input.store.readStream(tenantId, BILLING, {});
    const out: BillingEvent[] = [];
    for (const e of events) {
      if (e.event.type === 'BillingSubscriptionStarted') {
        const p = e.event.payload as StartedPayload;
        out.push({ kind: 'subscription_started', planId: p.planId, rail: p.rail, mandate: p.mandate, schedule: p.schedule, startedOn: p.startedOn, by: p.by });
      } else if (e.event.type === 'BillingSubscriptionCancelled') {
        const p = e.event.payload as CancelledPayload;
        out.push({ kind: 'subscription_cancelled', endsOn: p.endsOn, by: p.by, at: p.at });
      } else if (e.event.type === 'BillingChargeRecorded') {
        const p = e.event.payload as ChargePayload;
        out.push({ kind: 'charge_recorded', outcome: p.outcome, chargeRef: p.chargeRef, amountMinor: p.amountMinor, at: p.at });
      }
    }
    return out;
  };

  const snapshotOf = async (tenantId: string): Promise<BillingSnapshot | undefined> =>
    foldBilling({ tenantId, events: await readEvents(tenantId), policy, asAt: input.now() });

  return {
    now: input.now,
    plans: () => input.plans,
    subscription: (tenantId) => snapshotOf(tenantId),

    subscribe: async (tenantId, sub): Promise<SubscribeOutcome> => {
      const plan = input.plans.find((p) => p.planId === sub.planId);
      if (plan === undefined) throw new Error(`unknown plan ${sub.planId}`); // the route validated this first
      const at = input.now();
      const startsOn = at.slice(0, 10);
      const anchorDay = Math.min(28, Math.max(1, Number(startsOn.slice(8, 10)) || 1));
      const created = await input.provider.createSubscription({
        tenantId, plan, rail: sub.rail, anchorDay, startsOn, preDebitNoticeHours: noticeHours,
      });
      const version = (await allOf<StartedPayload>(input.store, tenantId, BILLING, 'BillingSubscriptionStarted')).length + 1;
      const payload: StartedPayload = {
        planId: sub.planId, rail: sub.rail, mandate: created.mandate, schedule: created.schedule, startedOn: startsOn, by: sub.by,
      };
      await input.store.append(tenantId, BILLING, makeEvent({
        id: `sub-start-${tenantId}-v${version}`,
        type: 'BillingSubscriptionStarted',
        occurredAt: at,
        idempotencyKey: `sub-start-${tenantId}-v${version}`,
        source: 'api/platform',
        payload,
      }));
      const snapshot = await snapshotOf(tenantId);
      if (snapshot === undefined) throw new Error('subscription did not persist'); // unreachable — just started
      return { snapshot, authorisationUrl: created.authorisationUrl, providerMode: input.provider.mode };
    },

    cancel: async (tenantId, by): Promise<BillingSnapshot | undefined> => {
      const events = await readEvents(tenantId);
      const current = foldBilling({ tenantId, events, policy, asAt: input.now() });
      if (current === undefined) return undefined;
      const at = input.now();
      const endsOn = current.nextCharge?.chargeOn ?? at.slice(0, 10);
      const version = events.filter((e) => e.kind === 'subscription_cancelled').length + 1;
      const payload: CancelledPayload = { endsOn, by, at };
      await input.store.append(tenantId, BILLING, makeEvent({
        id: `sub-cancel-${tenantId}-v${version}`,
        type: 'BillingSubscriptionCancelled',
        occurredAt: at,
        idempotencyKey: `sub-cancel-${tenantId}-v${version}`,
        source: 'api/platform',
        payload,
      }));
      return snapshotOf(tenantId);
    },

    handleWebhook: async ({ rawBody, signature }): Promise<WebhookOutcome> => {
      if (!input.provider.verifyWebhook({ rawBody, signature })) {
        return { verified: false, applied: false, detail: 'signature did not verify' };
      }
      const event = input.provider.parseChargeEvent(rawBody);
      if (event === undefined) return { verified: true, applied: false, detail: 'not a charge event this endpoint records' };
      const payload: ChargePayload = { outcome: event.outcome, chargeRef: event.chargeRef, amountMinor: event.amountMinor, at: event.at };
      await input.store.append(event.tenantId, BILLING, makeEvent({
        id: `charge-${event.tenantId}-${event.chargeRef}`,
        type: 'BillingChargeRecorded',
        occurredAt: event.at,
        // The charge reference is the key: a re-delivered webhook for the same charge collapses.
        idempotencyKey: `charge-${event.tenantId}-${event.chargeRef}`,
        source: 'api/platform',
        payload,
      }));
      const snapshot = await snapshotOf(event.tenantId);
      return { verified: true, applied: true, detail: `charge ${event.outcome} recorded`, dunning: snapshot?.dunning };
    },
  };
}

/**
 * The label a bill is shown under in a drill or a basket view: its largest single tender, or `unrecorded` when the
 * lane banked a sale with no tender detail — itself worth seeing (P-08). A LABEL only: the tender mix counts every
 * payment on a split bill under its own kind, by its own amount (`tenderSplit`, audit EA-02).
 */
function primaryTender(tenders: readonly IncomingTender[]): string {
  if (tenders.length === 0) return 'unrecorded';
  return [...tenders].sort((a, b) => b.amountMinor - a.amountMinor)[0]!.kind;
}

export function reportingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /**
   * The shop's trading calendar — its time zone and trading-day cut-off, from tenant settings (M01-FR-02). "Today" on
   * the dashboard is the SHOP's trading day, never this server's calendar date (audit finding F14). Required, not
   * defaulted: a composition that cannot say which day the shop is on has no business calling anything "today".
   */
  readonly calendar: (tenantId: string) => Promise<TradingCalendar> | TradingCalendar;
  /**
   * What this shop records and what this build can work out — the two facts the report catalogue
   * needs (M29/M30). Declared by the composition root because neither is the reporting service's to
   * invent; conservative by default (nothing claimed) so the catalogue never overstates the shop.
   */
  readonly records?: readonly Producer[];
  readonly produced?: readonly string[];
  /**
   * Minutes after which a figure is lagging, and stale. Per tenant when the composition says so; else the section-32
   * defaults (5 and 60) the figure engine applies.
   */
  readonly thresholds?: { readonly laggingAfterMinutes: number; readonly staleAfterMinutes: number };
  /** The named-report producers (EA-06, `report-producers.ts`); absent, every named report is refused as not produced. */
  readonly produce?: ReportingDeps['produce'];
  /**
   * EA-01 (round 4): the branches head office knows and each store computer's own last sync report for sales
   * (`services/platform/src/sync-watermarks.ts`). When given, a store's sales are as at the LATER of its newest sale and
   * its box's reported watermark, and a known branch never heard from is listed, stale. Absent on a bare wiring.
   */
  readonly storeSync?: (tenantId: string) => Promise<StoreSyncView>;
}): ReportingDeps {
  const thresholds = input.thresholds ?? {};
  /** Where a sale came from (audit EA-01): the store location the lane sells from, else the lane itself. */
  const sourceOf = (s: IncomingSale): string =>
    (typeof s.locationId === 'string' && s.locationId !== '' ? `store:${s.locationId}` : `lane:${s.laneId}`);
  /**
   * The newest sale head office holds from each source — the sources seen in `todays` (the read already made), plus
   * the source of the newest sale it has ever received (one index hit), so a shop that has not traded today is still
   * judged by when it was last heard from rather than dropped. Empty only when no sale has ever arrived.
   */
  const salesWatermarks = async (tenantId: string, todays: readonly PersistedEvent[]): Promise<readonly { source: string; lastEventAt: string }[]> => {
    const newest = new Map<string, string>();
    const note = (e: PersistedEvent): void => {
      const source = sourceOf(payloadOf<IncomingSale>(e));
      const held = newest.get(source);
      if (held === undefined || Date.parse(e.event.occurredAt) > Date.parse(held)) newest.set(source, e.event.occurredAt);
    };
    for (const e of todays) note(e);
    const latestEver = await input.store.latestOfType(tenantId, STREAM.sales, 'SaleCommitted');
    if (latestEver !== undefined) note(latestEver);
    return [...newest.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([source, lastEventAt]) => ({ source, lastEventAt }));
  };
  /** Every sales source's freshness — newest sale held, merged with the store computer's own watermark (EA-01). */
  const salesSources = async (tenantId: string, todays: readonly PersistedEvent[]): Promise<readonly SourceFreshness[]> => {
    const now = input.now();
    const marks = await salesWatermarks(tenantId, todays);
    if (input.storeSync === undefined) {
      if (marks.length === 0) return [sourceFreshness({ source: 'any till', domain: 'sales', lastEventAt: null, now, ...thresholds })];
      return marks.map((m) => sourceFreshness({ source: m.source, domain: 'sales', lastEventAt: m.lastEventAt, now, ...thresholds }));
    }
    return mergeStoreSync(marks, await input.storeSync(tenantId), now, thresholds, 'all');
  };
  return {
    now: input.now,
    ...(input.produce === undefined ? {} : { produce: input.produce }),

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
      // "Today" is the SHOP's trading day — its time zone and cut-off from tenant settings — not this server's
      // calendar date. A cloud box keeps UTC; the till dates every sale by the shop's wall clock and cut-off
      // (`tradingDayFor`), so between the shop's midnight and 05:30 IST the two disagreed and the owner's figure
      // read the wrong day (audit finding F14). One rule, both ends.
      const calendar = await input.calendar(tenantId);
      const today = tradingDayIn(input.now(), calendar);
      // A read of today, not a read of every sale the shop has ever made followed by a filter.
      // The owner looks at this number every morning, which makes it the one query in the system
      // guaranteed to be run against the largest table daily, forever.
      //
      // The window is on `occurredAt` and the check is on `tradingDay`, and both are needed: the
      // window is what makes the read cheap, and the trading day is what makes it *right*, because
      // a shop trading past midnight books those sales to the day that is still open (M09). The
      // window is the trading day's own span — from the shop's cut-off to the next one, in the
      // shop's zone — so it is exactly one day of sales whatever the zone and whatever the cut-off.
      const window = tradingDayWindow(today, calendar);
      const events = await input.store.readStream(tenantId, STREAM.sales, {
        type: 'SaleCommitted',
        from: window.from,
        to: window.to,
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
        // Every payment by its own kind and amount (EA-02): a ₹250 card + ₹50 cash bill is ₹250 card and ₹50 cash.
        tenders: s.tenders.map((t) => ({ kind: t.kind, amountMinor: t.amountMinor })),
        currency: s.currency as CurrencyCode,
      }));
      const summary = salesSummary(facts, (todays[0]?.currency as CurrencyCode) ?? 'INR');

      // As at the SOURCE's time, never the read time (audit EA-01): an 08:00 sale read at 16:00 is "as at 08:00, stale",
      // not "as at 16:00, live". The store box drains its queue in order (edge/sync-agent ORDER), so the newest sale
      // head office holds from a store is that store's sync watermark — everything it rang before then has arrived.
      // The figure is as current as its STALEST source; a shop no till has ever reached is "not available", never 0.
      // Round 4: each store's time is the LATER of its newest sale and its store computer's own reported watermark (a
      // quiet hour is not a stale store; a store whose line is down stops reporting and ages) — see `mergeStoreSync`.
      const timed = (await salesSources(tenantId, events)).map(syncedThrough).filter((t): t is string => t !== null);
      const asAt = timed.length === 0
        ? null
        : timed.reduce((oldest, t) => (Date.parse(t) < Date.parse(oldest) ? t : oldest));
      const now = input.now();
      const never = 'no till has ever sent a sale to head office, so there is nothing to report yet';
      // Round 4 (P-08): an old figure from a store that has since said it holds nothing unsent is old because nothing new
      // happened — said so, instead of "wait for the sync".
      const nothingUnsentAt = nothingUnsentAtFor(await latestStoreReports(input.store, tenantId), await salesWatermarks(tenantId, events));
      const of = (name: string, valueMinor: number, unit: Figure['unit']): Figure =>
        figure({ name, ...(asAt === null ? { notAvailableBecause: never } : { valueMinor }), unit, asAt, now, ...thresholds, ...(nothingUnsentAt === undefined ? {} : { nothingUnsentAt }) });

      // Round 4 (M29 · P-08): the day's returns, valued exactly as the day book values them (OB-34 points share included),
      // shown BESIDE "Sales today" with the net — "Sales today" keeps its meaning. Only when a return happened, so a day
      // with none reads as before.
      const returnedToday = (await dayBookAdapter({ store: input.store, now: input.now }).returnsOn(tenantId, today))
        .reduce((t, r) => t + returnedValueOf(r), 0);
      return [
        of('Sales today', summary.grossSalesMinor, 'minor_currency'),
        of('Sales today — receipts', summary.basketCount, 'count'),
        // One figure per tender the day actually saw (deterministic order), each an exact sum from the engine — every
        // payment on a split bill under its own kind (EA-02), so the tender figures add back to "Sales today".
        ...Object.keys(summary.tenderMix).sort()
          .map((kind) => of(`Sales today — ${kind}`, summary.tenderMix[kind]!, 'minor_currency')),
        ...(returnedToday === 0 ? [] : [
          of('Returned today', returnedToday, 'minor_currency'),
          of('Sales today net of returns', summary.grossSalesMinor - returnedToday, 'minor_currency'),
        ]),
      ];
    },

    // Each store's (or, for a lane that names no store location, each lane's) sales watermark, judged against now —
    // the per-source freshness the dashboard carries (M29-FR-01 "freshness per branch/domain", EA-01).
    sources: async (tenantId) => {
      const calendar = await input.calendar(tenantId);
      const window = tradingDayWindow(tradingDayIn(input.now(), calendar), calendar);
      const events = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: window.from, to: window.to });
      return salesSources(tenantId, events);
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
    effectiveGrants(input.store, tenantId);

  return {
    now: input.now,
    recordCutoverGo: (tenantId, go) => recordCutoverGoIn(input.store, tenantId, go),

    target: (tenantId) => ({
      targetId: `tgt-${tenantId}`, tenantId,
      kind: input.targetKind, label: input.targetKind,
    }),

    // One row per domain: the LATEST finding for each. A witness re-run appends a new fact; the page shows
    // the newest, and the history stays in the ledger (hard rule #6).
    findings: async (tenantId) => {
      const all = await allOf<DomainFinding>(input.store, tenantId, STREAM.migration, 'MigrationFindingRaised');
      const byDomain = new Map<string, DomainFinding>();
      for (const f of all) byDomain.set(f.domain, f);
      return [...byDomain.values()];
    },
    acceptances: (tenantId) => allOf<Acceptance>(input.store, tenantId, STREAM.migration, 'MigrationExceptionAccepted'),
    signatures: (tenantId) => allOf<Signature>(input.store, tenantId, STREAM.migration, 'MigrationReportSigned'),

    // MG-10 — the parallel run the server keeps (B3). Newest policy applies; a day compared twice is the later
    // state; a difference's state is its latest event (raised, then owned / resolved); rollbacks are all kept.
    parallelPolicy: async (tenantId) => latest<ParallelRunPolicy>(input.store, tenantId, STREAM.migration, 'ParallelRunPolicySet'),
    parallelDays: async (tenantId) => {
      const all = await allOf<RecordedParallelDay>(input.store, tenantId, STREAM.migration, 'ParallelDayCompared');
      const byDate = new Map<string, RecordedParallelDay>();
      for (const d of all) byDate.set(d.businessDate, d);
      return [...byDate.values()];
    },
    parallelDifferences: async (tenantId) => {
      const all = await allOf<ParallelDifference>(input.store, tenantId, STREAM.migration, 'ParallelDifferenceRecorded');
      const byId = new Map<string, ParallelDifference>();
      for (const d of all) byId.set(d.differenceId, d);
      return [...byId.values()];
    },
    // GT-02: a rollback is DECIDED (RollbackDecided), then — only with execution evidence — PERFORMED (RollbackPerformed).
    // Both facts are kept (hard rule #6); one row per decision, at its latest state. An old RollbackPerformed with no
    // execution evidence stays on the register but never demonstrates a rollback (`ledgerCutoverEvidence`).
    // GT-04: what a delta APPLIED — each change once, with its stock movement in the same atomic write.
    appliedDeltaKeys: async (tenantId) =>
      (await allOf<AppliedDelta>(input.store, tenantId, streamName(STREAM.migration, 'delta'), 'MigrationDeltaApplied')).map((d) => d.changeKey),
    deltaAppliedAt: async (tenantId) =>
      (await allOf<AppliedDelta>(input.store, tenantId, streamName(STREAM.migration, 'delta'), 'MigrationDeltaApplied')).map((d) => d.appliedAt).sort().at(-1),
    applyDeltaChange: async (tenantId, applied, movement) => {
      await input.store.appendBatch(tenantId, [
        movementEvent(tenantId, movement),
        {
          stream: streamName(STREAM.migration, 'delta'),
          event: makeEvent({
            id: `delta-${applied.changeKey}`, type: 'MigrationDeltaApplied', occurredAt: applied.appliedAt,
            // The change's own key: the same change re-sent under any HTTP key, or after a restart, collapses to one.
            idempotencyKey: `delta-${tenantId}-${applied.changeKey}`, source: 'api/migration', payload: applied,
          }),
        },
      ]);
    },
    // GT-04 money: a legacy sale's ledger vouchers and the applied record in ONE atomic write, keyed on the change — the
    // vouchers on the SAME finance stream (and with the same event keys) the day book's own journals use, so the day
    // book, the period close and every ledger read see them; a retry under any key or after a restart is the same, once.
    applyDeltaSale: async (tenantId, applied, journals) => {
      await input.store.appendBatch(tenantId, [
        ...journals.map((j) => ({
          stream: STREAM.finance,
          event: makeEvent({ id: `je-${j.entryId}`, type: 'JournalPosted', occurredAt: applied.appliedAt, idempotencyKey: `je-${tenantId}-${j.entryId}`, source: 'api/migration', payload: j }),
        })),
        {
          stream: streamName(STREAM.migration, 'delta'),
          event: makeEvent({
            id: `delta-${applied.changeKey}`, type: 'MigrationDeltaApplied', occurredAt: applied.appliedAt,
            idempotencyKey: `delta-${tenantId}-${applied.changeKey}`, source: 'api/migration', payload: applied,
          }),
        },
      ]);
    },
    postingMap: (tenantId) => latest<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined'),
    periodStates: (tenantId) => financeAdapter(input).periodStates(tenantId),
    nextOpenPeriod: (tenantId) => financeAdapter(input).nextOpenPeriod(tenantId),
    rollbacks: async (tenantId) => {
      const decided = await allOf<RecordedRollback>(input.store, tenantId, STREAM.migration, 'RollbackDecided');
      const performed = await allOf<RecordedRollback>(input.store, tenantId, STREAM.migration, 'RollbackPerformed');
      const byDecision = new Map<string, RecordedRollback>();
      for (const r of [...decided, ...performed]) byDecision.set(`${r.cutoverId}|${r.decidedAt}`, r);
      return [...byDecision.values()];
    },
    recordParallelPolicy: async (tenantId, policy) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('parallel-policy', `parallel-policy-${tenantId}-${policy.cutoverId}-${policy.setAt}`), type: 'ParallelRunPolicySet', occurredAt: policy.setAt,
        idempotencyKey: `parallel-policy-${tenantId}-${policy.cutoverId}-${policy.setAt}`, source: 'api/migration', payload: policy,
      }));
    },
    recordParallelDay: async (tenantId, day) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('parallel-day', `parallel-day-${tenantId}-${day.businessDate}-${day.recordedAt}`), type: 'ParallelDayCompared', occurredAt: day.recordedAt,
        idempotencyKey: `parallel-day-${tenantId}-${day.businessDate}-${day.recordedAt}`, source: 'api/migration', payload: day,
      }));
    },
    recordParallelDifference: async (tenantId, difference) => {
      // Id + state: raised, then owned, then resolved are three facts on one difference; a retry of one collapses.
      const state = `${difference.status}-${difference.ownerUserId ?? ''}-${difference.explanation ?? ''}`;
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `parallel-diff-${difference.differenceId}-${difference.status}`, type: 'ParallelDifferenceRecorded', occurredAt: input.now(),
        idempotencyKey: `parallel-diff-${tenantId}-${difference.differenceId}-${state}`, source: 'api/migration', payload: difference,
      }));
    },
    // GT-02 round 4: each reconciliation of a rollback's data (append-only — one that did not balance stays too).
    rollbackReconciliations: (tenantId) => allOf<RollbackReconciliation>(input.store, tenantId, STREAM.migration, 'RollbackReconciled'),
    recordRollbackReconciliation: async (tenantId, c) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('rollback-reconciled', `rollback-reconciled-${tenantId}-${c.cutoverId}-${c.decidedAt}-${c.at}`), type: 'RollbackReconciled', occurredAt: c.at,
        idempotencyKey: `rollback-reconciled-${tenantId}-${c.cutoverId}-${c.decidedAt}-${c.at}`, source: 'api/migration', payload: c,
      }));
    },
    // The bills and takings head office holds for the new system's window — from ITS OWN sales ledger, by when each sale
    // was rung (a day either side is read, then each sale is judged by its own time).
    windowSales: async (tenantId, from, to) => {
      const day = 86_400_000;
      const events = await input.store.readStream(tenantId, STREAM.sales, {
        type: 'SaleCommitted', from: new Date(Date.parse(from) - day).toISOString(), to: new Date(Date.parse(to) + day).toISOString(),
      });
      const inWindow = events.map((e) => payloadOf<IncomingSale>(e))
        .filter((s) => Date.parse(s.committedAt) >= Date.parse(from) && Date.parse(s.committedAt) < Date.parse(to));
      return { count: inWindow.length, totalMinor: inWindow.reduce((n, s) => n + s.totalMinor, 0) };
    },
    // OB-50: the window's refunds (every return head office holds — against a bill and without one — by when it was
    // processed) and each product's net stock movement (every movement, by when it happened, signed by its kind).
    windowFacts: async (tenantId, from, to) => {
      const inWindow = (at: string): boolean => Date.parse(at) >= Date.parse(from) && Date.parse(at) < Date.parse(to);
      const returns = new Map<string, ReturnRecord>();
      for (const stream of [STREAM.returns, NO_RECEIPT_RETURNS]) {
        for (const r of await allOf<ReturnRecord>(input.store, tenantId, stream, 'ReturnRecorded')) if (inWindow(r.processedAt)) returns.set(r.returnId, r);
      }
      const net = new Map<string, number>();
      for (const e of await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })) {
        const m = payloadOf<Movement>(e);
        if (!inWindow(m.occurredAt)) continue;
        net.set(m.productId, (net.get(m.productId) ?? 0) + EFFECT_ON_HAND[m.kind] * m.quantityMinor);
      }
      return {
        refunds: { count: returns.size, totalMinor: [...returns.values()].reduce((n, r) => n + r.refundMinor, 0) },
        stockMovements: [...net].filter(([, q]) => q !== 0).map(([productId, netQuantityMinor]) => ({ productId, netQuantityMinor })).sort((a, b) => a.productId.localeCompare(b.productId)),
      };
    },
    // Every store head office knows, and how far its computer says its sales have synced (EA-01); never heard → null.
    storeSalesSyncedThrough: async (tenantId) => {
      const view = await storeSyncView(input.store, tenantId, input.now);
      const ids = [...new Set([...view.branches.keys(), ...view.sales.keys()])].sort();
      return ids.map((storeId) => ({ storeId, completeThrough: view.sales.get(storeId)?.completeThrough ?? null }));
    },
    recordRollback: async (tenantId, rollback) => {
      // The decision and its confirmation are two facts with two keys — a confirmation never collapses onto the decision.
      const performed = rollback.state === 'performed';
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('rollback', `rollback-${tenantId}-${rollback.cutoverId}-${rollback.decidedAt}-${performed ? 'performed' : 'decided'}`),
        type: performed ? 'RollbackPerformed' : 'RollbackDecided',
        occurredAt: performed ? rollback.execution!.confirmedAt : rollback.decidedAt,
        idempotencyKey: `rollback-${tenantId}-${rollback.cutoverId}-${rollback.decidedAt}-${performed ? 'performed' : 'decided'}`,
        source: 'api/migration', payload: rollback,
      }));
    },

    recordExtractionRun: async (tenantId, run) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `extraction-run-${run.runId}`, type: 'ExtractionRun', occurredAt: run.startedAt,
        idempotencyKey: `extraction-run-${tenantId}-${run.runId}`, source: 'api/migration', payload: run,
      }));
    },
    recordFinding: async (tenantId, finding) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        // Domain + the outside document it rests on: the same evidence re-sent is one finding; new
        // evidence for the same domain is a new, later finding.
        id: `finding-${finding.domain}-${finding.evidenceRef}`, type: 'MigrationFindingRaised', occurredAt: finding.recordedAt,
        idempotencyKey: `finding-${tenantId}-${finding.domain}-${finding.evidenceRef}`, source: 'api/migration', payload: finding,
      }));
    },
    // MG-05 — who ran each trial load (2b-vi-c-2): one record per trial; the control-total signature reads it.
    recordTrialLoad: async (tenantId, load) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `trial-load-${load.trialId}`, type: 'MigrationTrialLoadRun', occurredAt: load.at,
        idempotencyKey: `trial-load-${tenantId}-${load.trialId}`, source: 'api/migration', payload: load,
      }));
    },
    trialLoadOperators: async (tenantId) => {
      const loads = await allOf<{ readonly operator: string }>(input.store, tenantId, STREAM.migration, 'MigrationTrialLoadRun');
      return [...new Set(loads.map((l) => l.operator))];
    },
    // MG-05 / MG-06 (cutover readiness): the load record — one fact per staging (load id + digest), its operator the
    // signed-in caller; the named acceptance of a staging's exception list; and what landed when it was applied.
    loadRecords: (tenantId) => allOf<LoadRecord>(input.store, tenantId, STREAM.migration, 'MigrationLoadRecorded'),
    recordLoad: async (tenantId, record) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('mig-load', `mig-load-${tenantId}-${record.loadId}-${record.sliceDigest}`), type: 'MigrationLoadRecorded', occurredAt: record.recordedAt,
        idempotencyKey: `mig-load-${tenantId}-${record.loadId}-${record.sliceDigest}`, source: 'api/migration', payload: record,
      }));
    },
    sliceAcceptances: async (tenantId, loadId) =>
      (await allOf<SliceAcceptance & { readonly loadId: string }>(input.store, tenantId, STREAM.migration, 'MigrationLoadExceptionsAccepted')).filter((a) => a.loadId === loadId),
    recordSliceAcceptance: async (tenantId, loadId, acceptance) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('mig-load-accept', `mig-load-accept-${tenantId}-${loadId}-${acceptance.sliceDigest}`), type: 'MigrationLoadExceptionsAccepted', occurredAt: acceptance.acceptedAt,
        idempotencyKey: `mig-load-accept-${tenantId}-${loadId}-${acceptance.sliceDigest}`, source: 'api/migration', payload: { ...acceptance, loadId },
      }));
    },
    loadsApplied: async (tenantId, loadId) =>
      (await allOf<LoadApplied>(input.store, tenantId, STREAM.migration, 'MigrationLoadApplied')).filter((a) => a.loadId === loadId),
    recordLoadApplied: async (tenantId, applied) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('mig-load-applied', `mig-load-applied-${tenantId}-${applied.loadId}-${applied.sliceDigest}-${applied.appliedAt}`), type: 'MigrationLoadApplied', occurredAt: applied.appliedAt,
        idempotencyKey: `mig-load-applied-${tenantId}-${applied.loadId}-${applied.sliceDigest}-${applied.appliedAt}`, source: 'api/migration', payload: applied,
      }));
    },
    // MG-10: each signature a parallel-run day has had — kept even after the day is re-recorded (it then no longer applies).
    parallelDaySignatures: (tenantId) => allOf<ParallelDaySignature>(input.store, tenantId, STREAM.migration, 'ParallelDaySigned'),
    recordParallelDaySignature: async (tenantId, signature) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: keyedEventId('parallel-day-signed', `parallel-day-signed-${tenantId}-${signature.businessDate}-${signature.dayDigest}`), type: 'ParallelDaySigned', occurredAt: signature.signedAt,
        idempotencyKey: `parallel-day-signed-${tenantId}-${signature.businessDate}-${signature.dayDigest}`, source: 'api/migration', payload: signature,
      }));
    },
    recordSignature: async (tenantId, signature) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        // One signature per person per role per PAGE (the findings digest): signing the same page twice
        // collapses; signing a later page is a new fact.
        id: `signature-${signature.reportId}-${signature.findingsDigest}-${signature.role}-${signature.signedBy}`,
        type: 'MigrationReportSigned', occurredAt: signature.signedOn,
        idempotencyKey: `signature-${tenantId}-${signature.reportId}-${signature.findingsDigest}-${signature.role}-${signature.signedBy}`,
        source: 'api/migration', payload: signature,
      }));
    },

    // Every exclusion, latest state per id — the proposal, then the owner's written decision. A
    // history exclusion goes proposed → approved/rejected; the fold keeps the newest per id (MG-07).
    exclusions: async (tenantId) => {
      const all = await allOf<HistoryExclusion>(input.store, tenantId, STREAM.migration, 'MigrationHistoryExclusion');
      const byId = new Map<string, HistoryExclusion>();
      for (const e of all) byId.set(e.exclusionId, e);
      return [...byId.values()];
    },

    recordExclusion: async (tenantId, exclusion) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        // The exclusion id AND its status — proposing then deciding are two append-only facts on one
        // exclusion; re-sending the same transition collapses, a decision after a proposal does not.
        id: `mg-exclusion-${exclusion.exclusionId}-${exclusion.status}`,
        type: 'MigrationHistoryExclusion',
        occurredAt: exclusion.status === 'proposed' ? exclusion.proposedAt : (exclusion.approvedAt ?? input.now()),
        idempotencyKey: `mg-exclusion-${tenantId}-${exclusion.exclusionId}-${exclusion.status}`,
        source: 'api/migration',
        payload: exclusion,
      }));
    },

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

    /**
     * The roles a user actually holds in this tenant, read from the append-only grant history — so a
     * control-total signature's authority (is the signer a chartered accountant?) is decided from the
     * ledger, never from what the request claims about itself.
     */
    rolesOf: async (tenantId, userId) =>
      (await grants(tenantId)).filter((g) => g.userId === userId).map((g) => g.roleId),

    // MG-04 / MG-06 — the decisions the migration screen makes, KEPT (C3a). An exception is its first record
    // with its first resolution applied (a second resolution never lands — the route refuses it, and the fold
    // keeps the first regardless); a total is its first record with its first signature applied. Refused relayed
    // decisions are all kept. Every writer is keyed on the subject so a re-delivered decision appends once.
    exceptions: async (tenantId) => {
      const recorded = await allOf<MigrationException>(input.store, tenantId, STREAM.migration, 'MigrationExceptionRecorded');
      const resolutions = await allOf<{ readonly exceptionId: string; readonly resolution: ExceptionResolution }>(input.store, tenantId, STREAM.migration, 'MigrationExceptionResolved');
      const byId = new Map<string, MigrationException>();
      for (const e of recorded) if (!byId.has(e.exceptionId)) byId.set(e.exceptionId, e);
      for (const r of resolutions) {
        const e = byId.get(r.exceptionId);
        if (e !== undefined && e.resolution === undefined) byId.set(r.exceptionId, { ...e, resolution: r.resolution });
      }
      return [...byId.values()];
    },
    recordException: async (tenantId, exception) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `mig-exception-${exception.exceptionId}`, type: 'MigrationExceptionRecorded', occurredAt: input.now(),
        idempotencyKey: `mig-exception-${tenantId}-${exception.exceptionId}`, source: 'api/migration', payload: exception,
      }));
    },
    recordExceptionResolution: async (tenantId, exceptionId, resolution) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `mig-exception-resolved-${exceptionId}`, type: 'MigrationExceptionResolved', occurredAt: resolution.decidedAt,
        idempotencyKey: `mig-exception-resolved-${tenantId}-${exceptionId}`, source: 'api/migration', payload: { exceptionId, resolution },
      }));
    },
    controlTotals: async (tenantId) => {
      const recorded = await allOf<ControlTotal>(input.store, tenantId, STREAM.migration, 'MigrationControlTotalRecorded');
      const signatures = await allOf<{ readonly totalId: string; readonly signature: TotalSignature }>(input.store, tenantId, STREAM.migration, 'MigrationTotalSigned');
      const byId = new Map<string, ControlTotal>();
      for (const t of recorded) if (!byId.has(t.totalId)) byId.set(t.totalId, t);
      for (const sg of signatures) {
        const t = byId.get(sg.totalId);
        if (t !== undefined && t.signature === undefined) byId.set(sg.totalId, { ...t, signature: sg.signature });
      }
      return [...byId.values()];
    },
    recordControlTotal: async (tenantId, total) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `mig-total-${total.totalId}`, type: 'MigrationControlTotalRecorded', occurredAt: input.now(),
        idempotencyKey: `mig-total-${tenantId}-${total.totalId}`, source: 'api/migration', payload: total,
      }));
    },
    recordTotalSignature: async (tenantId, totalId, signature) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `mig-total-signed-${totalId}`, type: 'MigrationTotalSigned', occurredAt: signature.signedAt,
        idempotencyKey: `mig-total-signed-${tenantId}-${totalId}`, source: 'api/migration', payload: { totalId, signature },
      }));
    },
    refusedDecisions: (tenantId) => allOf<RefusedDecision>(input.store, tenantId, STREAM.migration, 'MigrationDecisionRefused'),
    recordRefusedDecision: async (tenantId, decision) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `mig-refused-${decision.decisionId}`, type: 'MigrationDecisionRefused', occurredAt: decision.relayedAt,
        idempotencyKey: `mig-refused-${tenantId}-${decision.decisionId}`, source: 'api/migration', payload: decision,
      }));
    },
    // Whether a person named at the store box genuinely holds a permission — from their grants and the role
    // catalogue, never from what the relay says about them (the same read canApproveRefund does).
    holdsPermission: async (tenantId, userId, permission) => {
      const roleIds = new Set((await grants(tenantId)).filter((g) => g.userId === userId).map((g) => g.roleId));
      return ROLE_CATALOGUE.some((r) => roleIds.has(r.id) && r.permissions.includes(permission));
    },
  };
}

/**
 * The domain endpoint a person calls to ACT on a data-quality finding — named, never invoked from
 * here. The AI drafts; a data steward acts through the ordinary catalogue route, which applies its
 * own permissions, approvals and audit (hard rule #5, P-05).
 */
const DATA_QUALITY_ROUTE: Readonly<Record<DataQualityFinding['kind'], string>> = {
  missing_barcode: 'POST /v1/catalogue/products/:productId/barcodes/:code',
  suspected_duplicate: 'POST /v1/catalogue/merges/:mergeId',
  missing_mrp: 'POST /v1/catalogue/products/:productId/publish',
};

/**
 * Turn A08's product data-quality findings into DRAFT proposals — each carrying the real product(s)
 * as evidence and naming the endpoint a human would call. No proposal here commits anything; the
 * run route stamps `committed: false` and the reply says `committedAnything: false`.
 */
function dataQualityProposals(findings: readonly DataQualityFinding[], now: string): Omit<Proposal, 'committed'>[] {
  return findings.map((f): Omit<Proposal, 'committed'> => ({
    // Deterministic from the finding — the same master yields the same proposal id.
    proposalId: f.findingId,
    agent: 'A08',
    summary: f.headline,
    wouldRequire: DATA_QUALITY_ROUTE[f.kind],
    evidence: f.evidence.map((e): AiEvidenceItem => ({
      source: 'product master',
      reference: e.sku.trim() === '' ? e.productId : e.sku,
      summary: `${e.name} — ${e.note}`,
    })),
    createdAt: now,
  }));
}

/**
 * Turn A08's suspicious-mapping findings into DRAFT proposals — each citing the SOURCE + column its rejection
 * history fingerprints, and naming where a steward reviews it. The action itself (re-map, agree a code list
 * with the supplier, fix the template) is off-system; the proposal points at the source's import-quality
 * review, and its evidence carries the count, the share and the corrective action. Commits nothing.
 */
function mappingQualityProposals(findings: readonly MappingQualityFinding[], now: string): Omit<Proposal, 'committed'>[] {
  return findings.map((f): Omit<Proposal, 'committed'> => ({
    proposalId: f.findingId,
    agent: 'A08',
    summary: f.headline,
    // Where a steward looks to act — the source's import-quality review (the fix is with the source, off-system).
    wouldRequire: 'GET /v1/purchase/import-quality/:sourceId',
    evidence: [{
      source: 'import history',
      reference: f.sourceId,
      summary: `"${f.column}": ${f.count} row(s) rejected (${Math.round(f.shareBps / 100)}% of this source's failures) — ${f.action}`,
    }],
    createdAt: now,
  }));
}

/**
 * Turn A06's operational-incident findings into DRAFT proposals — each explaining a live incident and naming
 * its runbook, citing the real persisted alert as evidence. A06 recommends; an OPERATOR acknowledges the alert
 * (taking ownership) and runs the runbook. Commits nothing (hard rule #5 / P-05).
 */
function operationsProposals(findings: readonly OperationsFinding[], now: string): Omit<Proposal, 'committed'>[] {
  return findings.map((f): Omit<Proposal, 'committed'> => ({
    proposalId: f.findingId,
    agent: 'A06',
    summary: f.headline,
    // The governance action a person takes: acknowledge the alert (take ownership), then run the runbook.
    wouldRequire: 'POST /v1/platform/alerts/:alertId/acknowledge',
    evidence: [{
      source: 'operational alerts',
      reference: f.alertId,
      summary: `${f.component} ${f.status} (owner ${String(f.evidence['owner'] ?? 'unassigned')}) — Runbook: ${f.runbook}`,
    }],
    createdAt: now,
  }));
}

/**
 * Turn A07's open investigations into prioritised DRAFT proposals — highest exposure first — each citing the
 * real case (its opaque SUBJECT REFERENCE, never a name — P-04) as evidence. A07 SUMMARISES and PRIORITISES;
 * it takes NO autonomous sanction (its whole authority forbids it). A security officer works the case through
 * the ordinary loss-prevention surface. Commits nothing (hard rule #5 / P-05).
 */
function investigationProposals(worklist: OpenCaseWorklist, now: string): Omit<Proposal, 'committed'>[] {
  return worklist.cases.map((c): Omit<Proposal, 'committed'> => ({
    proposalId: `sec-investigation:${c.caseId}`,
    agent: 'A07',
    summary: `Prioritise open investigation on ${c.subjectRef}: ${c.summary}`,
    // Where a security officer works it — the open-investigations worklist (the fix is casework, not an AI act).
    wouldRequire: 'GET /v1/loss-prevention/cases',
    evidence: [{
      source: 'loss-prevention cases',
      reference: c.caseId,
      summary: `subject ${c.subjectRef}: ${c.summary} — ${Math.round(c.valueMinor / 100)} at stake, ${c.evidenceCount} evidence item(s), open since ${c.openedAt.slice(0, 10)}, assigned to ${c.assignedTo}`,
    }],
    createdAt: now,
  }));
}

/**
 * Turn A03's near-expiry stock into DRAFT proposals — a markdown for a batch close to its use-by, a disposal
 * for one already expired, worst-first (the order the tested `nearExpiryStock` already returns). Each cites the
 * real batch on the cloud ledger (id, product, net-of-sales quantity on hand, expiry, days left) as evidence.
 * A03 SUGGESTS; a **manager** commits the money action the proposal names — a markdown through the price-change
 * approval path (`POST /v1/prices/changes`), a disposal through the write-off path — never the agent (hard rule
 * #5 / P-05). A markdown is a price change and a disposal removes stock, so neither is ever committed here.
 */
function inventoryProposals(items: readonly ExpiryActionItem[], now: string): Omit<Proposal, 'committed'>[] {
  return items.map((i): Omit<Proposal, 'committed'> => {
    const dispose = i.action === 'dispose';
    return {
      proposalId: `inv-${i.action}:${i.batchId}`,
      agent: 'A03',
      summary: dispose
        ? `Dispose batch ${i.batchId} of ${i.productId} — expired ${i.expiry}, ${i.qty} still on hand`
        : `Mark down batch ${i.batchId} of ${i.productId} — expires ${i.expiry} in ${i.daysToExpiry} day(s), ${i.qty} on hand`,
      // The governance action a manager commits — the AI only recommends it (hard rule #5).
      wouldRequire: dispose ? 'POST /v1/inventory/write-off/:writeOffId' : 'POST /v1/prices/changes',
      evidence: [{
        source: 'near-expiry stock (cloud ledger)',
        reference: i.batchId,
        summary: `${i.productId} batch ${i.batchId}: ${i.qty} on hand, expiry ${i.expiry} (${i.status}, ${i.daysToExpiry} day(s) to expiry) → ${i.action}`,
      }],
      createdAt: now,
    };
  });
}

/**
 * Turn A10's daily-task assessment into DRAFT guidance proposals — the ESCALATED (critical + overdue) and
 * OVERDUE tasks that need a person's attention, worst-first (the order `assessDailyTasks` already returns).
 * A10 gives role-aware guidance and takes NO HR decision (its whole authority forbids it): it flags what
 * needs attention; a MANAGER assigns or completes the task through the ordinary workforce route. Commits
 * nothing (hard rule #5 / P-05).
 */
function workforceGuidanceProposals(assessments: readonly WfTaskAssessment[], now: string): Omit<Proposal, 'committed'>[] {
  return assessments
    .filter((a) => a.status === 'escalated' || a.status === 'overdue')
    .map((a): Omit<Proposal, 'committed'> => ({
      proposalId: `wf-guidance:${a.status}:${a.taskId}`,
      agent: 'A10',
      summary: a.status === 'escalated'
        ? `Escalate: "${a.description}" (${a.forRole}) is CRITICAL and ${a.overdueByMinutes ?? 0} min overdue — needs the manager on duty`
        : `Overdue: "${a.description}" (${a.forRole}) is ${a.overdueByMinutes ?? 0} min overdue — assign someone`,
      // The governance action a MANAGER takes — complete/assign the task; the AI only flags it (hard rule #5).
      wouldRequire: 'POST /v1/hr/workforce/tasks/:taskId/complete',
      evidence: [{
        source: 'workforce daily tasks',
        reference: a.taskId,
        summary: `${a.description} — role ${a.forRole}${a.branchId === undefined ? '' : `, branch ${a.branchId}`}: ${a.detail}`,
      }],
      createdAt: now,
    }));
}

/**
 * Turn A09's drafted marketing audiences into DRAFT campaign-idea proposals — the segments worth a campaign,
 * best-margin-first (the order `draftMarketingAudiences` already returns). A09 DRAFTS segments within consent
 * and margin and takes NO commercial action (its authority forbids it): it names an audience worth targeting
 * and STATES the reach honestly — the contactable count and the number excluded for want of consent (P-08) —
 * and a MARKETING APPROVER builds and sends any campaign. Commits nothing (hard rule #5 / P-05); there is no
 * auto-send, and the per-channel consent check still binds at send time.
 */
function marketingGuidanceProposals(audiences: readonly MarketingAudienceDraft[], now: string): Omit<Proposal, 'committed'>[] {
  return audiences.map((a): Omit<Proposal, 'committed'> => ({
    proposalId: `mkt-audience:${a.segment}`,
    agent: 'A09',
    summary: `Campaign idea: the "${a.segment}" audience — ${a.contactable} contactable customer(s), ~${a.marginMinor} in lifetime margin`
      + (a.excludedForConsent > 0 ? ` (${a.excludedForConsent} more match but have not consented and are not contactable)` : ''),
    // The governance action a MARKETING APPROVER takes — build and send the campaign; the AI only drafts the
    // audience (hard rule #5). No campaign route is auto-called: a person reviews consent, offer and margin.
    wouldRequire: 'a marketing approver reviews and launches a campaign to this audience (no auto-send)',
    evidence: [{ source: 'customer segments', reference: a.segment, summary: a.detail }],
    createdAt: now,
  }));
}

/**
 * Turn A05's first-response SLA assessment into DRAFT service proposals — the OPEN cases nobody has replied
 * to yet that are past (breached) or near (at-risk) their first-response promise, worst-first. A05 answers
 * policy/order questions and DRAFTS case responses, and EXCEPTIONS ESCALATE to a person (its purpose): it
 * flags which customer is waiting and by how long, and a SERVICE AGENT replies (a supervisor approves any
 * AI-drafted reply). Commits nothing (hard rule #5 / P-05) — the first-response clock is the wait a customer
 * actually feels, so surfacing it is exactly the help without ever answering on the shop's behalf.
 */
function serviceGuidanceProposals(views: readonly { readonly serviceCase: ServiceCase; readonly sla: SlaView }[], now: string): Omit<Proposal, 'committed'>[] {
  return views.map(({ serviceCase: c, sla }): Omit<Proposal, 'committed'> => ({
    proposalId: `svc-case:${sla.status}:${c.caseId}`,
    agent: 'A05',
    summary: sla.shouldEscalate
      ? `Escalate: case ${c.caseId} ("${c.summary}", ${c.priority} ${c.kind}) has BREACHED its first-response SLA — ${sla.detail}`
      : `Reply soon: case ${c.caseId} ("${c.summary}", ${c.priority} ${c.kind}) is at risk of breaching — ${sla.detail}`,
    // The governance action a SERVICE AGENT takes — reply to the customer; the AI only flags it (hard rule #5).
    wouldRequire: 'POST /v1/service/cases/:caseId/first-response',
    evidence: [{ source: 'service desk cases', reference: c.caseId, summary: `${c.kind} from ${c.customerRef}: ${sla.detail}` }],
    createdAt: now,
  }));
}

/**
 * EA-09: annotate a shared-inbox entry from the SAME draft proposal a run of the agent raises for that finding (the ids
 * are the same by construction) — its evidence and the route a person acts through — and the branch of the governed
 * record behind it (`null` = shop-wide). An entry with no matching proposal carries no evidence, so the inbox withholds it.
 */
function annotateInbox<E extends { readonly finding: { readonly findingId: string } }>(
  proposals: readonly Omit<Proposal, 'committed'>[], branchOf: (entry: E) => string | null,
): (entry: E) => InboxEntry<E> {
  const byId = new Map(proposals.map((p) => [p.proposalId, p]));
  return (entry) => {
    const p = byId.get(entry.finding.findingId);
    return { ...entry, branchId: branchOf(entry), evidence: p?.evidence ?? [], wouldRequire: p?.wouldRequire ?? '' };
  };
}

export function aiAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /**
   * The live product master and its barcode register, for the Data Quality agent (A08). Optional:
   * without them A08 finds nothing rather than throwing — the same shape as every other agent whose
   * data source is not yet wired. The readers are the tested product/barcode folds, reused verbatim.
   */
  readonly products?: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  readonly barcodes?: (tenantId: string) => Promise<readonly BarcodeAssignment[]> | readonly BarcodeAssignment[];
  /**
   * The tenant's import history (M30-FR-04), for A08's suspicious-mapping leg. Optional, same shape as the
   * others: without it A08 simply raises no mapping findings. The tested import-quality fold, reused verbatim.
   */
  readonly importHistory?: (tenantId: string) => Promise<readonly ImportJobRecord[]> | readonly ImportJobRecord[];
  /**
   * The tenant's live operational alerts (M35-FR-04), for the Operations agent (A06). Optional, same shape as
   * the others: without it A06 recommends nothing. The tested alert-lifecycle fold, reused verbatim.
   */
  readonly operationsAlerts?: (tenantId: string) => Promise<readonly LiveAlert[]> | readonly LiveAlert[];
  /**
   * The tenant's loss-prevention investigation cases (M15-FR-04), for the Security/Fraud agent (A07).
   * Optional, same shape as the others: without it A07 prioritises nothing. The tested LP case fold, reused
   * verbatim; the worklist ordering is the tested `buildOpenCaseWorklist`.
   */
  readonly investigations?: (tenantId: string) => Promise<readonly InvestigationCase[]> | readonly InvestigationCase[];
  /**
   * The tenant's stored daily tasks (M25-FR-02), for the Workforce/SOP guidance agent (A10). Optional, same
   * shape as the others: without it A10 recommends nothing. The tested task-store fold, reused verbatim — the
   * same DailyTask list the tasks board runs `assessDailyTasks` over, so A10 flags the same tasks a human sees.
   */
  readonly dailyTasks?: (tenantId: string) => Promise<readonly WfDailyTask[]> | readonly WfDailyTask[];
  /**
   * The tenant's marketing-draft inputs (M16-FR-02), for the Marketing agent (A09): a profile per known
   * customer (marketing purpose) + each customer's folded consent, from the SAME stored facts + consent
   * ledger the stateful segmentation reads (`marketingDraftInputs`). Optional, same shape as the others:
   * without it A09 drafts nothing. `draftMarketingAudiences` runs here over what it returns.
   */
  readonly marketingDraft?: (tenantId: string) => Promise<{ readonly profiles: readonly SegCustomerProfile[]; readonly consents: readonly SegCustomerConsent[] }>;
  /** EA-08: the Customer Shopping agent's (A04) in-stock alternatives, from the product master, pack and stock ledger. */
  readonly shoppingAlternatives?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
  /**
   * The tenant's service-desk cases (M21), for the Service agent (A05). Optional, same shape as the others:
   * without it A05 surfaces nothing. The tested serviceCases fold the desk board reads; A05 runs the tested
   * assessFirstResponse over the OPEN, unanswered ones, so it flags the same waiting customers a human sees.
   */
  readonly serviceCases?: (tenantId: string) => Promise<readonly ServiceCase[]> | readonly ServiceCase[];
  /**
   * The tenant's near-expiry stock (M10-FR-01 · ADR-0015), for the Inventory agent (A03). Optional, same shape
   * as the others: without it A03 suggests nothing. The tested `nearExpiryStock` fold over the cloud ledger —
   * the SAME reader the `/v1/inventory/near-expiry` route uses (`nearExpiryAdapter(...).nearExpiry`).
   */
  readonly nearExpiry?: NearExpiryDeps['nearExpiry'];
  /** EA-08 — A01's read-only insights and A02's stock-out reorder drafts, from the governed readers (ai-insights.ts). */
  readonly ownerInsights?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
  readonly purchaseSuggestions?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
  /** Round 8 — A03's transfer-suggestion leg: out at a selling place, held elsewhere (ai-insights.ts `transferSuggestions`). */
  readonly transferSuggestions?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
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
        id: keyedEventId('kill', `kill-${tenantId}-${at}-${String(on)}`),
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

    setBudget: async (tenantId, budget, by, at) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('ai-budget', `ai-budget-${tenantId}-${at}`),
        type: 'AiBudgetSet',
        occurredAt: at,
        // Keyed on the moment it was set — a later cap is the owner changing the limit, latest wins;
        // the same set re-sent (a retry) collapses.
        idempotencyKey: `ai-budget-${tenantId}-${at}`,
        source: 'api/ai',
        payload: { capMinor: budget.capMinor, periodEnds: budget.periodEnds, by, at },
      }));
    },

    /** Nothing is enabled until somebody enables it, by name (AID-01…10). */
    enabledAgents: async (tenantId) =>
      (await latest<{ readonly agents: readonly AgentId[] }>(
        input.store, tenantId, STREAM.ai, 'AiAgentsEnabled',
      ))?.agents ?? [],

    setEnabledAgents: async (tenantId, agents, by, at) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('ai-enabled', `ai-enabled-${tenantId}-${at}`),
        type: 'AiAgentsEnabled',
        occurredAt: at,
        // The enabled SET as of this moment — latest wins, so enabling is declarative (the new list is
        // the whole truth), not additive; a re-sent identical change collapses.
        idempotencyKey: `ai-enabled-${tenantId}-${at}`,
        source: 'api/ai',
        payload: { agents, by, at },
      }));
    },

    /**
     * A run READS and DRAFTS — it commits nothing and, for A08, writes nothing to any store.
     *
     * The Data Quality agent (A08) is deterministic and needs no model: it scans the tenant's live
     * product master for the gaps that can actually occur — a sellable item with no barcode, two
     * records that look like the same thing, an item with no printed MRP — and returns each as a
     * DRAFT proposal citing the real product(s). A person acts through the ordinary catalogue
     * endpoint the proposal names; nothing here changes any product (hard rule #5, P-05).
     *
     * Every other agent still returns nothing — it becomes reachable when its own data source is
     * wired (and, for a model-backed agent, a provider is chosen, OB-02).
     */
    // EA-08: every run is recorded — the run, its server-metered cost, and each accepted proposal onto the register —
    // in ONE atomic write, idempotent on the run id.
    recordRun: async (tenantId, run) => {
      await input.store.appendBatch(tenantId, [
        { stream: STREAM.ai, event: makeEvent({ id: `ai-run-${run.runId}`, type: 'AiRunRecorded', occurredAt: run.at, idempotencyKey: `ai-run-${tenantId}-${run.runId}`, source: 'api/ai', payload: run }) },
        { stream: STREAM.ai, event: makeEvent({ id: `ai-cost-${run.runId}`, type: 'AiRunCosted', occurredAt: run.at, idempotencyKey: `ai-cost-${tenantId}-${run.runId}`, source: 'api/ai', payload: { runId: run.runId, agent: run.agent, costMinor: run.costMinor, calledAModel: run.calledAModel } }) },
        ...run.proposals.map((p) => ({ stream: STREAM.ai, event: makeEvent({ id: `ai-proposal-${p.proposalId}`, type: 'AiProposalRaised', occurredAt: run.at, idempotencyKey: `ai-proposal-${tenantId}-${p.proposalId}`, source: 'api/ai', payload: p }) })),
      ]);
    },

    run: async (tenantId, agent) => {
      const now = input.now();
      // A01 Owner Intelligence — read-only insights from the governed reports; proposes no action (EA-08).
      if (agent === 'A01') return input.ownerInsights === undefined ? [] : input.ownerInsights(tenantId);
      // A02 Purchase — stock-outs with recent demand, as DRAFTS for a buyer; no quantity invented, no order raised.
      if (agent === 'A02') return input.purchaseSuggestions === undefined ? [] : input.purchaseSuggestions(tenantId);
      // A04 Customer Shopping — in-stock alternatives for what has run out, as DRAFTS the customer confirms (EA-08).
      if (agent === 'A04') return input.shoppingAlternatives === undefined ? [] : input.shoppingAlternatives(tenantId);
      // A08 Data Quality — the product master + import history.
      if (agent === 'A08') {
        const proposals: Omit<Proposal, 'committed'>[] = [];
        // Leg 1+2 — the product master: missing barcode / suspected duplicate / missing MRP.
        if (input.products !== undefined && input.barcodes !== undefined) {
          const findings = assessProductDataQuality({
            products: await input.products(tenantId),
            barcodes: new BarcodeRegistry(await input.barcodes(tenantId)),
          });
          proposals.push(...dataQualityProposals(findings, now));
        }
        // Leg 3 — suspicious mappings from import history: a source that keeps failing on one column.
        // An independent data source, so it runs whether or not the product master is wired.
        if (input.importHistory !== undefined) {
          const findings = assessMappingQuality({ jobs: await input.importHistory(tenantId) });
          proposals.push(...mappingQualityProposals(findings, now));
        }
        return proposals;
      }
      // A06 Operations — explain the live operational incidents and recommend a runbook for each.
      if (agent === 'A06') {
        if (input.operationsAlerts === undefined) return [];
        const findings = recommendOperationsRunbooks(liveNotCleared(await input.operationsAlerts(tenantId)));
        return operationsProposals(findings, now);
      }
      // A07 Security/Fraud — prioritise the open investigations by exposure. NO autonomous sanctions.
      if (agent === 'A07') {
        if (input.investigations === undefined) return [];
        const worklist = buildOpenCaseWorklist(await input.investigations(tenantId));
        return investigationProposals(worklist, now);
      }
      // A03 Inventory — the near-expiry stock now on hand: mark down before it expires, dispose what already has.
      // Round 8: and the transfer leg — out at a selling place while another place of the company holds it (a manager decides).
      if (agent === 'A03') {
        const items = input.nearExpiry === undefined ? [] : await input.nearExpiry(tenantId, { asOf: now.slice(0, 10), nearExpiryDays: 7 });
        const transfers = input.transferSuggestions === undefined ? [] : await input.transferSuggestions(tenantId);
        return [...inventoryProposals(items, now), ...transfers];
      }
      // A10 Workforce/SOP guidance — the day's tasks that need attention (escalated + overdue), role-aware.
      // NO HR decision (its authority forbids it): it flags, a manager assigns/completes. The SAME tested
      // `assessDailyTasks` over the SAME stored tasks the workforce board reads.
      if (agent === 'A10') {
        if (input.dailyTasks === undefined) return [];
        const report = assessDailyTasks({ tasks: await input.dailyTasks(tenantId), now });
        return workforceGuidanceProposals(report.assessments, now);
      }
      // A09 Marketing — the segments worth a campaign, within consent and by margin, best-margin-first. NO
      // commercial action (its authority forbids it): it drafts the audience, a marketing approver launches.
      // The SAME tested segmentation over the SAME stored facts + consent the audience board reads (M16-FR-02).
      if (agent === 'A09') {
        if (input.marketingDraft === undefined) return [];
        const { profiles, consents } = await input.marketingDraft(tenantId);
        return marketingGuidanceProposals(draftMarketingAudiences({ profiles, consents }), now);
      }
      // A05 Service — the open cases nobody has answered yet that are breaching/at-risk on first response,
      // worst-first. Exceptions escalate; a service agent replies (hard rule #5). The SAME tested
      // assessFirstResponse over the SAME stored cases the service-desk board reads.
      if (agent === 'A05') {
        if (input.serviceCases === undefined) return [];
        const views = (await input.serviceCases(tenantId))
          .filter((c) => c.state === 'open' && c.firstRespondedAt === undefined)
          .map((c) => ({ serviceCase: c, sla: assessFirstResponse({ serviceCase: c, now }) }))
          .filter((v) => v.sla.status === 'breached' || v.sla.status === 'at_risk')
          .sort((a, b) =>
            Number(b.sla.shouldEscalate) - Number(a.sla.shouldEscalate) // breached (escalate) before at-risk
            || a.sla.remainingMinutes - b.sla.remainingMinutes          // most overdue / least time left first
            || a.serviceCase.caseId.localeCompare(b.serviceCase.caseId));
        return serviceGuidanceProposals(views, now);
      }
      return [];
    },

    openProposals: (tenantId) => allOf<Proposal>(input.store, tenantId, STREAM.ai, 'AiProposalRaised'),

    /**
     * The Data Quality steward's inbox — the live A08 findings folded with the stewards' dismissals.
     * A pure READ: it re-derives the findings from the current master (so a fixed gap leaves the list
     * on its own) and folds the dismissals latest-per-finding. Nothing is written here.
     */
    dataQualityWorklist: async (tenantId) => {
      // One dismissal ledger serves BOTH legs — a steward's judgement is keyed by findingId, and the
      // two families of id never collide (`dq-*` for product gaps, `dq-mapping:*` for suspicious
      // mappings), so a single latest-per-id fold applies each decision to whichever finding it names.
      const latest = new Map<string, SuggestionDisposition>();
      for (const d of await allOf<SuggestionDisposition>(input.store, tenantId, STREAM.ai, 'AiDataQualityDismissed')) {
        latest.set(d.findingId, d); // occurrence order → the last decision on a finding wins
      }
      const dispositions = [...latest.values()];

      // Leg 1+2 — the product master.
      const productFindings = (input.products === undefined || input.barcodes === undefined)
        ? []
        : assessProductDataQuality({
            products: await input.products(tenantId),
            barcodes: new BarcodeRegistry([...(await input.barcodes(tenantId))]),
          });
      const productWL = buildDataQualityWorklist({ findings: productFindings, dispositions });

      // Leg 3 — suspicious mappings from import history (an independent source; absent → nothing here).
      const mappingFindings = input.importHistory === undefined
        ? []
        : assessMappingQuality({ jobs: await input.importHistory(tenantId) });
      const mappingWL = buildDataQualityWorklist({ findings: mappingFindings, dispositions });

      // Merge the two folds into one worklist, each entry tagged by its source so the screen can label
      // it. Product suggestions lead (the everyday catalogue gaps), then the mapping suggestions.
      // EA-09: both legs rest on shop-wide records (one product master, P-02; import sources are head office's), so
      // their branch is null — every reader sees them, only a company-wide steward sets one aside.
      const now = input.now();
      const product = annotateInbox<{ readonly source: 'product' } & (typeof productWL.open)[number]>(dataQualityProposals(productFindings, now), () => null);
      const mapping = annotateInbox<{ readonly source: 'mapping' } & (typeof mappingWL.open)[number]>(mappingQualityProposals(mappingFindings, now), () => null);
      const open = [
        ...productWL.open.map((i) => product({ source: 'product' as const, ...i })),
        ...mappingWL.open.map((i) => mapping({ source: 'mapping' as const, ...i })),
      ];
      const dismissed = [
        ...productWL.dismissed.map((i) => product({ source: 'product' as const, ...i })),
        ...mappingWL.dismissed.map((i) => mapping({ source: 'mapping' as const, ...i })),
      ];
      return { open, dismissed, openCount: open.length, dismissedCount: dismissed.length };
    },

    /**
     * A steward's judgement that a suggestion is (not) a problem — a HUMAN write, recorded in the
     * human's name (`by` is the authenticated caller, stamped by the route). Append-only, latest-wins;
     * a reopen (`dismissed:false`) is another event, never an erasure (hard rule #2/#6).
     */
    recordDataQualityDisposition: async (tenantId, disposition, key) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('dq-disposition', `dq-disposition-${tenantId}-${key}`),
        type: 'AiDataQualityDismissed',
        occurredAt: disposition.at,
        idempotencyKey: `dq-disposition-${tenantId}-${key}`,
        source: 'api/ai',
        payload: disposition,
      }));
    },

    /**
     * The Operations operator's inbox (A06) — the live incident recommendations folded with the operators'
     * dismissals. A pure READ: it RE-DERIVES the recommendations from the live alerts (the SAME tested
     * recommendOperationsRunbooks the run uses), so an incident that has been acknowledged/cleared leaves the
     * list on its own; the inbox never drifts from the live alert board. Dismissals fold latest-per-finding.
     * Nothing is written here. Without an alerts reader wired, the list is simply empty.
     */
    operationsWorklist: async (tenantId) => {
      const latest = new Map<string, SuggestionDisposition>();
      for (const d of await allOf<SuggestionDisposition>(input.store, tenantId, STREAM.ai, 'AiOperationsDismissed')) {
        latest.set(d.findingId, d); // occurrence order → the last decision on a finding wins
      }
      const findings = input.operationsAlerts === undefined
        ? []
        : recommendOperationsRunbooks(liveNotCleared(await input.operationsAlerts(tenantId)));
      const wl = buildDataQualityWorklist({ findings, dispositions: [...latest.values()] });
      // EA-09: the branch is the one the alert's rule watches (a store computer's own component); none = shop-wide.
      const annotate = annotateInbox<(typeof wl.open)[number]>(operationsProposals(findings, input.now()), (e) => e.finding.branchId ?? null);
      return { ...wl, open: wl.open.map(annotate), dismissed: wl.dismissed.map(annotate) };
    },

    /**
     * An operator's judgement that a recommendation is (not) worth acting on — a HUMAN write, recorded in the
     * human's name (`by` is the authenticated caller, stamped by the route). Append-only, latest-wins; a
     * reopen (`dismissed:false`) is another event, never an erasure (hard rule #2/#6).
     */
    recordOperationsDisposition: async (tenantId, disposition, key) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('ops-disposition', `ops-disposition-${tenantId}-${key}`),
        type: 'AiOperationsDismissed',
        occurredAt: disposition.at,
        idempotencyKey: `ops-disposition-${tenantId}-${key}`,
        source: 'api/ai',
        payload: disposition,
      }));
    },

    /**
     * The Workforce/SOP manager's inbox (A10) — the day's escalated/overdue task guidance folded with the
     * managers' dismissals. A pure READ: it RE-DERIVES the guidance from the live daily tasks (the SAME tested
     * assessDailyTasks the run uses, at the current clock so "overdue" is measured now), so a task that has
     * been completed/assigned leaves the list on its own; the inbox never drifts from the task board.
     * Dismissals fold latest-per-finding. Nothing is written here. Without a tasks reader wired, the list is
     * simply empty.
     */
    workforceWorklist: async (tenantId) => {
      const latest = new Map<string, SuggestionDisposition>();
      for (const d of await allOf<SuggestionDisposition>(input.store, tenantId, STREAM.ai, 'AiWorkforceDismissed')) {
        latest.set(d.findingId, d); // occurrence order → the last decision on a finding wins
      }
      const report = input.dailyTasks === undefined ? undefined : assessDailyTasks({ tasks: await input.dailyTasks(tenantId), now: input.now() });
      const findings = report === undefined ? [] : taskGuidanceFindings(report);
      const wl = buildDataQualityWorklist({ findings, dispositions: [...latest.values()] });
      // EA-09: the branch is the task's own (a task naming none is shop-wide).
      const annotate = annotateInbox<(typeof wl.open)[number]>(workforceGuidanceProposals(report?.assessments ?? [], input.now()), (e) => e.finding.branchId ?? null);
      return { ...wl, open: wl.open.map(annotate), dismissed: wl.dismissed.map(annotate) };
    },

    /**
     * A manager's judgement that a piece of guidance is (not) worth acting on now — a HUMAN write, recorded in
     * the human's name (`by` is the authenticated caller, stamped by the route). Append-only, latest-wins; a
     * reopen (`dismissed:false`) is another event, never an erasure (hard rule #2/#6). It records only the
     * manager's set-aside note — it commits no HR action (the task is completed/assigned the ordinary way).
     */
    recordWorkforceDisposition: async (tenantId, disposition, key) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('wf-disposition', `wf-disposition-${tenantId}-${key}`),
        type: 'AiWorkforceDismissed',
        occurredAt: disposition.at,
        idempotencyKey: `wf-disposition-${tenantId}-${key}`,
        source: 'api/ai',
        payload: disposition,
      }));
    },
  };
}

// ── The day book (M23-FR-01) ───────────────────────────────────────────────────────────────────
// Reads the operational ledger (sales by TRADING day, returns by the day they were processed) and the
// catalogue's rates; appends day-book journals through the same `appendJournal` the manual route uses, so
// the period fold, the posters list and the close gate see them as journals like any other. The mapping
// and the exceptions are append-only facts on the finance stream — latest mapping wins; an exception is
// never deleted (hard rule #6), it is `resolved` when a later posting covers its sources.
export function dayBookAdapter(input: { readonly store: EventStore; readonly now: () => string }): DayBookDeps {
  const fin = financeAdapter(input);
  // A trading day can run past midnight; read a generous clock window and filter on the day itself.
  const window = (day: string): { readonly from: string; readonly to: string } => {
    const start = Date.parse(`${day}T00:00:00.000Z`);
    return { from: new Date(start - 24 * 3_600_000).toISOString(), to: new Date(start + 2 * 24 * 3_600_000).toISOString() };
  };
  return {
    periodStates: fin.periodStates,
    nextOpenPeriod: fin.nextOpenPeriod,
    appendJournal: fin.appendJournal,
    now: input.now,
    postingMap: (tenantId) => latest<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined'),
    definePostingMap: async (tenantId, map) => {
      await input.store.append(tenantId, STREAM.finance, makeEvent({
        id: `posting-map-${map.version}`,
        type: 'PostingMapDefined',
        occurredAt: map.definedAt,
        idempotencyKey: `posting-map-${tenantId}-v${map.version}`,
        source: 'api/finance',
        payload: map,
      }));
    },
    salesOn: async (tenantId, day) => {
      const { from, to } = window(day);
      const events = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from, to });
      return events.map((e) => payloadOf<IncomingSale>(e)).filter((s) => s.tradingDay === day);
    },
    returnsOn: async (tenantId, day) => {
      const { from, to } = window(day);
      const events = await input.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from, to });
      const returns = events.map((e) => payloadOf<ReturnRecord>(e)).filter((r) => r.processedAt.slice(0, 10) === day);
      // OB-34 "A": the value of the points each return gave back to the member (head office's give-back fact, on the
      // sale's loyalty stream) rides on the return, so the day book reverses the whole returned value.
      return Promise.all(returns.map(async (r) => {
        if (r.originalSaleId === null) return r;
        const given = (await input.store.readStream(tenantId, streamName(STREAM.loyalty, 'sale', r.originalSaleId)))
          .filter((e) => e.event.type === 'LoyaltyReturnGaveBack').map((e) => payloadOf<ReturnGiveBack>(e))
          .find((g) => g.returnId === r.returnId);
        return given === undefined || given.valueMinor <= 0 ? r : { ...r, pointsGivenBackMinor: given.valueMinor };
      }));
    },
    originalSales: async (tenantId, saleIds) => {
      const out = new Map<string, DayBookSale>();
      for (const saleId of saleIds) {
        const held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`);
        if (held !== undefined) out.set(saleId, held.event.payload as IncomingSale);
      }
      return out;
    },
    taxRates: async (tenantId) => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return new Map((pack?.snapshot.products ?? []).map((p) => [p.productId, p.taxBps] as const));
    },
    dayBookJournals: async (tenantId, day) =>
      (await allOf<JournalEntry | DayBookJournal>(input.store, tenantId, STREAM.finance, 'JournalPosted'))
        .filter((j): j is DayBookJournal => 'dayBook' in j && j.dayBook.tradingDay === day),
    recordException: async (tenantId, e) => {
      await input.store.append(tenantId, STREAM.finance, makeEvent({
        id: `daybook-exc-${e.exceptionId}`,
        type: 'DayBookExceptionRaised',
        occurredAt: e.raisedAt,
        idempotencyKey: `daybook-exc-${tenantId}-${e.exceptionId}`,
        source: 'api/finance',
        payload: e,
      }));
    },
    exceptionsOn: async (tenantId, day) =>
      (await allOf<DayBookExceptionRecord>(input.store, tenantId, STREAM.finance, 'DayBookExceptionRaised'))
        .filter((e) => e.tradingDay === day),
    // PF-09 step 3: the points the day's sales earned and the day's returns took back, valued at the earn's point value.
    loyaltyOn: async (tenantId, sales, returns) => {
      const factsOf = async (saleId: string) => {
        const events = await input.store.readStream(tenantId, streamName(STREAM.loyalty, 'sale', saleId));
        const earn = events.find((e) => e.event.type === 'LoyaltySaleEarned');
        return {
          earn: earn === undefined ? undefined : payloadOf<SaleEarn>(earn),
          takeBacks: events.filter((e) => e.event.type === 'LoyaltyReturnTakenBack').map((e) => payloadOf<ReturnTakeBack>(e)),
        };
      };
      const out: DayBookLoyalty[] = [];
      for (const sale of sales) {
        const { earn } = await factsOf(sale.saleId);
        if (earn !== undefined && earn.points > 0) out.push({ sourceId: `earn:${sale.saleId}`, kind: 'earn', points: earn.points, valueMinor: earn.points * (earn.pointValuePaise ?? 0) });
      }
      for (const ret of returns) {
        if (ret.originalSaleId === null) continue;
        const { earn, takeBacks } = await factsOf(ret.originalSaleId);
        const t = takeBacks.find((x) => x.returnId === ret.returnId);
        if (earn !== undefined && t !== undefined && t.taken > 0) out.push({ sourceId: `takeback:${ret.returnId}`, kind: 'takeback', points: t.taken, valueMinor: t.taken * (earn.pointValuePaise ?? 0) });
      }
      return out;
    },
  };
}

/** PF-13: concession lines taken on a day their counter could not trade — one tenant-wide stream, kept for a person. */
const CONCESSION_TRADING_BREACHES = streamName(STREAM.settlement, 'concession-trading-breaches');

// ── Concession docket tags (M27-FR-03) ────────────────────────────────────────────────────────
// Every capture and every correction is an appended version of the tag on the contract's tag stream;
// "current" is the longest history. The contract read is the concession adapter's own.
export function concessionTagsAdapter(input: { readonly store: EventStore; readonly now: () => string }): ConcessionTagDeps {
  return {
    now: input.now,
    contract: async (tenantId, contractId) =>
      latest<ConcessionContract>(input.store, tenantId, forConcession(contractId), 'ConcessionContractSet'),
    tags: (tenantId, contractId) => latestConcessionTags(input.store, tenantId, contractId),
    contractsFor: async (tenantId, concessionaireId) => {
      const indexed = await allOf<{ readonly contractId: string; readonly concessionaireId: string }>(input.store, tenantId, CONCESSION_CONTRACT_INDEX, 'ConcessionContractIndexed');
      const ids = [...new Set(indexed.filter((c) => c.concessionaireId === concessionaireId).map((c) => c.contractId))];
      const contracts: ConcessionContract[] = [];
      for (const contractId of ids) {
        const c = await latest<ConcessionContract>(input.store, tenantId, forConcession(contractId), 'ConcessionContractSet');
        if (c !== undefined) contracts.push(c);
      }
      return contracts;
    },
    allContracts: async (tenantId) => {
      const indexed = await allOf<{ readonly contractId: string }>(input.store, tenantId, CONCESSION_CONTRACT_INDEX, 'ConcessionContractIndexed');
      const contracts: ConcessionContract[] = [];
      for (const contractId of [...new Set(indexed.map((c) => c.contractId))]) {
        const c = await latest<ConcessionContract>(input.store, tenantId, forConcession(contractId), 'ConcessionContractSet');
        if (c !== undefined) contracts.push(c);
      }
      return contracts;
    },
    recordTradingBreach: async (tenantId, breach) => {
      await input.store.append(tenantId, CONCESSION_TRADING_BREACHES, makeEvent({
        id: `concession-breach-${breach.tagId}`, type: 'ConcessionTradingBreach', occurredAt: breach.recordedAt,
        idempotencyKey: `concession-breach-${tenantId}-${breach.tagId}`, source: 'api/finance', payload: breach,
      }));
    },
    tradingBreaches: (tenantId) => allOf<ConcessionTradingBreach>(input.store, tenantId, CONCESSION_TRADING_BREACHES, 'ConcessionTradingBreach'),
    appendTag: async (tenantId, tag) => {
      const version = tag.history.length;
      await input.store.append(tenantId, forConcessionTags(tag.contractId), makeEvent({
        id: `concession-tag-${tag.tagId}-v${version}`,
        type: 'ConcessionTagRecorded',
        occurredAt: tag.history[version - 1]?.at ?? tag.at,
        idempotencyKey: `concession-tag-${tenantId}-${tag.tagId}-v${version}`,
        source: 'api/finance',
        payload: tag,
      }));
    },
    rolesOf: async (tenantId, userId) =>
      (await effectiveGrants(input.store, tenantId))
        .filter((g) => g.userId === userId)
        .map((g) => g.roleId),
  };
}

// ── Observed operational health (M35-FR-03 / FR-04 / FR-01) ───────────────────────────────────
// The cloud's own ledgers as health signals: the newest synced sale, the connector queues, the latest
// pack, the adapters' heartbeats, the recorded backups; the alert rules and the raised alerts are facts
// on the platform stream (the alerts through the same lifecycle adapter the manual raise uses).
const BACKUPS_STREAM = streamName(STREAM.platform, 'backups');
const ALERT_RULES_STREAM = streamName(STREAM.platform, 'alert-rules');
/** Round 33 · OB-120: the write guard every alert-rules save is conditional on (one per tenant). */
const ALERT_RULES_GUARD = 'alert-rules';
export function observedHealthAdapter(input: {
  readonly store: EventStore; readonly now: () => string;
  /** Verifier r22 D3: the owner's unsent line (platform.box_unsent_warn_hours) — absent, its default (2 hours). */
  readonly boxUnsentWarnHours?: (tenantId: string) => Promise<number>;
  /** OB-90: the owner's claim slack (platform.box_claim_slack_numbers / _percent) — absent, its default (5 / 5%). */
  readonly boxClaimSlack?: (tenantId: string) => Promise<ClaimSlack>;
  /** Round 27 · OB-100: the store's time zone (locale.time_zone) — the calendar days unused numbers are shown by. */
  readonly storeTimeZone?: (tenantId: string) => Promise<string>;
  /** Round 27 · OB-102: where the never-received fold's saved running result lives (PostgreSQL in production). */
  readonly snapshots?: SnapshotStore;
  /** Round 29 · OB-106: how long a health read waits for the store computers' history being built (default BOX_HISTORY_BUILD_WAIT_MS). */
  readonly boxHistoryWaitMs?: number;
  /** Round 30 · OB-111: the key the saved history is sealed with (`boxHistorySealKey`); absent, nothing saved is trusted (said on the health read). */
  readonly boxHistorySealKey?: BoxHistorySealKey;
}): ObservedHealthDeps {
  const lifecycle = alertLifecycleAdapter(input);
  return {
    now: input.now,
    alerts: lifecycle.alerts,
    recordAlertEvent: lifecycle.recordAlertEvent,
    lastSaleSyncedAt: async (tenantId) => (await input.store.latestOfType(tenantId, STREAM.sales, 'SaleCommitted'))?.event.occurredAt,
    catalogueBuiltAt: async (tenantId) =>
      (await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished'))?.snapshot.builtAt,
    connectorQueues: async (tenantId) => {
      const seen = await allOf<{ readonly connectorId: string }>(input.store, tenantId, STREAM.integration, 'ConnectorSeen');
      const ids = [...new Set(seen.map((c) => c.connectorId))].sort();
      const out: ConnectorQueueDepth[] = [];
      for (const connectorId of ids) {
        const queue = replayConnectorQueue(await allOf<ConnectorDeliveryEvent>(input.store, tenantId, forConnectorDelivery(connectorId), 'ConnectorDelivery'));
        out.push({
          connectorId,
          queued: queue.filter((m) => m.state === 'queued' || m.state === 'in_flight').length,
          deadLettered: queue.filter((m) => m.state === 'dead_lettered').length,
        });
      }
      return out;
    },
    integrationHealth: async (tenantId, at) => {
      const configs = new Map<string, AdapterConfig>();
      for (const c of await allOf<AdapterConfig>(input.store, tenantId, STREAM.integration, 'IntegrationAdapterRegistered')) configs.set(c.adapterId, c);
      const heartbeats = await allOf<AdapterHeartbeat>(input.store, tenantId, STREAM.integration, 'IntegrationHeartbeat');
      const out: Record<string, boolean> = {};
      for (const config of configs.values()) {
        const health = adapterHealth({ config, heartbeats, at });
        if (health.state === 'disabled') continue;
        out[config.adapterId] = health.state === 'healthy';
      }
      return out;
    },
    // PA-12 round 7: a backup is believed only from a grant of the backup_job role ITSELF — never a person's other roles.
    // PA-12 round 10: …and only from a machine identity that holds NOTHING else — a ledger from before the grant-time
    // rule that gave a person backup_job beside their own roles is not believed.
    // PA-12 round 12: …and only from a MACHINE credential (no interactive sign-in evidence), never a person's identity (a
    // sign-in at the identity server), and with every role held NOW — a live emergency grant of anything else included.
    isBackupJob: async (tenantId, userId, evidence) => {
      if (!isMachineCredential(evidence)) return false;
      if (await isPersonNow(input.store, tenantId, userId)) return false;
      const held = await rolesHeldNow(input.store, tenantId, userId, input.now());
      return held.includes(BACKUP_JOB_ROLE_ID) && held.every((r) => r === BACKUP_JOB_ROLE_ID);
    },
    backups: (tenantId) => allOf<BackupRecord>(input.store, tenantId, BACKUPS_STREAM, 'BackupTaken'),
    recordBackup: async (tenantId, record) => {
      await input.store.append(tenantId, BACKUPS_STREAM, makeEvent({
        id: `backup-${record.backupId}`,
        type: 'BackupTaken',
        occurredAt: record.at,
        idempotencyKey: `backup-${tenantId}-${record.backupId}`,
        source: 'api/platform',
        payload: record,
      }));
    },
    // PA-12: the store computers' own sync reports are lane signals — the stalest store's last complete sync (its
    // stalest queue), and what their queues still hold or had refused.
    storeLanes: async (tenantId) => {
      const latestByStore = latestPerStore(await syncWatermarksAdapter({ store: input.store }).records(tenantId));
      if (latestByStore.size === 0) return undefined;
      let stalest: { at: string | null; store: string } | undefined;
      let unsent = 0; let deadLettered = 0;
      for (const [storeId, r] of latestByStore) {
        const times = r.domains.map((d) => d.completeThrough);
        const storeAt = times.some((t) => t === null) ? null
          : (times as string[]).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
        if (stalest === undefined || stalest.at !== null && (storeAt === null || Date.parse(storeAt) < Date.parse(stalest.at))) stalest = { at: storeAt, store: storeId };
        unsent += r.domains.reduce((n, d) => n + d.unsent, 0);
        deadLettered += r.domains.reduce((n, d) => n + d.deadLettered, 0);
      }
      return { stalestCompleteAt: stalest!.at, stalestStore: stalest!.store, unsent, deadLettered, stores: latestByStore.size };
    },
    // M35-FR-03: the store computers' own health reports (disk, queue, till devices) and the stores head office knows.
    storeComputers: async (tenantId, at) => {
      // Verifier r19: bills issued and never received (sales lost by a restore), and box reports head office refused.
      // Round 27 · OB-102: from the saved running result; OB-100: with the unused numbers; OB-101: with the bindings.
      // Round 28 · OB-104: ONLY the reports after the box history's saved running result are read — never every report.
      const reading = await storeComputerHistory(input.store, tenantId, at ?? input.now(), {
        ...(input.boxUnsentWarnHours === undefined ? {} : { unsentWarnHours: await input.boxUnsentWarnHours(tenantId) }),
        ...(input.boxClaimSlack === undefined ? {} : { claimSlack: await input.boxClaimSlack(tenantId) }),
        ...(input.storeTimeZone === undefined ? {} : { timeZone: await input.storeTimeZone(tenantId) }),
        ...(input.snapshots === undefined ? {} : { snapshots: input.snapshots }),
        ...(input.boxHistoryWaitMs === undefined ? {} : { waitMs: input.boxHistoryWaitMs }),
        ...(input.boxHistorySealKey === undefined ? {} : { sealKey: input.boxHistorySealKey }),
      });
      return {
        records: [], view: reading.view,
        knownStores: (await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId)).filter((n) => n.kind === 'branch').map((n) => n.nodeId),
        billNumberFindings: reading.findings, bindings: reading.bindings, unusedNumbers: reading.unused, unusedCapped: reading.unusedCapped,
        // Round 29 · OB-105/106: the saved history itself — being prepared, its size, saving held back by an open transaction.
        ...(reading.preparing === undefined ? {} : { preparing: reading.preparing }), history: reading.history,
        // Round 26 · OB-97: the owner-approved "store computer replaced" acts — the same binding the findings were judged on.
        replacements: await boxHealthAdapter({ store: input.store }).replacements(tenantId),
        // Verifier r20 HW-2: whether the bill-number high-water is waiting on an open database transaction (read after the
        // findings, whose count just ran the fold).
        billNumberHighWater: (await highWaterFenceWait(input.store, tenantId)) ?? null,
        // Round 33 · OB-121: the reports refused at the door, one bounded line per store computer per day.
        refusedAtDoor: await refusedAtDoorLines(input.store, tenantId),
      };
    },
    // OB-95: the people who hold both the IT/platform role and a business role (granted before the rule), with any live
    // emergency grant — listed for the owner, never silently kept.
    separationOfDuties: async (tenantId) => {
      const now = input.now();
      const grants = [...await effectiveGrants(input.store, tenantId)];
      const emergency = (await allOf<EmergencyGrant>(input.store, tenantId, EMERGENCY_ACCESS_STREAM, 'EmergencyAccessRecorded'))
        .reduce((m, g) => m.set(g.grantId, g), new Map<string, EmergencyGrant>());
      for (const g of emergency.values()) if ((g.revokedAt ?? null) === null && Date.parse(g.expiresAt) > Date.parse(now)) grants.push({ userId: g.userId, roleId: g.roleId, branchScope: g.branchScope });
      return combinedDuties(grants, ROLE_CATALOGUE);
    },
    alertRules: (tenantId) => latest<StoredAlertRules>(input.store, tenantId, ALERT_RULES_STREAM, 'AlertRulesDefined'),
    // Round 31 · OB-114: the built-in rules go to whoever holds the owner role now (read from the grants, never written in code).
    shopOwner: async (tenantId) => {
      const owners = [...new Set((await effectiveGrants(input.store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
      return owners[0] === undefined ? undefined : { userId: owners[0], name: `the owner (${owners[0]})` };
    },
    // Round 34 · OB-124 (2): EVERY person who holds the owner role now — the built-in rules reach each one (never anyone else).
    shopOwners: async (tenantId) => [...new Set((await effectiveGrants(input.store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort()
      .map((userId) => ({ userId, name: `the owner (${userId})` })),
    // Round 32 · OB-115: who may change a BUILT-IN rule — only a person who holds the owner role; whether this person holds
    // the IT/platform administration function is said too (refused by name, as OB-91).
    builtInRuleAuthorityOf: (tenantId, userId) => builtInAuthorityOf(input.store, tenantId, userId),
    // Round 36 · verifier r35 NEW-1: the person an owner's redirect of a built-in rule names still receives it only while they
    // hold a role that may see alerts (platform.health.read) — else it goes to every owner (said on the page).
    mayReceiveAlerts: async (tenantId, userId) => (await effectiveGrants(input.store, tenantId)).some((g) => g.userId === userId
      && (ROLE_CATALOGUE.find((r) => r.id === g.roleId)?.permissions.includes('platform.health.read') ?? false)),
    // Round 33 · OB-120: the rules' write guard — read before the rules in force, passed back on the save.
    alertRulesGuardVersion: (tenantId) => input.store.guardVersion(tenantId, ALERT_RULES_GUARD),
    defineAlertRules: async (tenantId, rules, opts) => {
      // Round 33 · OB-120 (verifier r32 NEW-3): each SAVE is its own event (keyed on the version AND the request that made it),
      // so two saves of the same version never dedup onto each other; the guard makes the append conditional — the second of
      // two saves based on one version is refused by name (ConcurrencyConflictError → 409), never silently answered "saved".
      // A re-send of the same request (same key) is the same save and collapses onto it.
      const save = createHash('sha256').update(opts?.saveKey ?? randomUUID()).digest('hex').slice(0, 16);
      const key = `alert-rules-${tenantId}-v${rules.version}-${save}`;
      await input.store.appendBatch(tenantId, [{
        stream: ALERT_RULES_STREAM,
        event: makeEvent({ id: keyedEventId('alert-rules', key), type: 'AlertRulesDefined', occurredAt: rules.definedAt, idempotencyKey: key, source: 'api/platform', payload: rules }),
      }], opts?.expectedGuardVersion === undefined ? undefined : { guard: { key: ALERT_RULES_GUARD, expectedVersion: opts.expectedGuardVersion } });
    },
  };
}

/**
 * Versioned document templates (M01-FR-02). Every state a version reaches — drafted, approved, published,
 * superseded — is one appended fact on the org stream; the routes fold the furthest state per version.
 * A superseded version is never removed: the receipts printed under it name it, and a reprint next year
 * must look like the original (hard rules #2 and #6).
 */
export function documentTemplatesAdapter(input: { readonly store: EventStore; readonly now: () => string }): DocumentTemplateDeps {
  const stream = streamName(STREAM.org, 'document-templates');
  return {
    now: input.now,
    versions: (tenantId) => allOf<DocumentTemplateVersion>(input.store, tenantId, stream, 'DocumentTemplateVersionRecorded'),
    record: async (tenantId, version) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `doc-template-${version.kind}-v${version.version}-${version.state}`,
        type: 'DocumentTemplateVersionRecorded',
        occurredAt: input.now(),
        idempotencyKey: `doc-template-${tenantId}-${version.kind}-v${version.version}-${version.state}`,
        source: 'api/platform',
        payload: version,
      }));
    },
  };
}

/**
 * A store's settings as head office holds them (PA-06 = DF-3-a): each change a `StoreSettingsSet` version on the org's
 * store-settings stream; the settings in force are the latest per store (hard rule #2).
 */
const STORE_SETTINGS_STREAM = streamName(STREAM.org, 'store-settings');
export function storeSettingsAdapter(input: { readonly store: EventStore }): {
  settings: (tenantId: string, storeId: string) => Promise<StoreSettings | undefined>;
  recordSettings: (tenantId: string, s: StoreSettings) => Promise<void>;
} {
  return {
    settings: async (tenantId, storeId) => {
      let latest: StoreSettings | undefined;
      for (const s of await allOf<StoreSettings>(input.store, tenantId, STORE_SETTINGS_STREAM, 'StoreSettingsSet')) if (s.storeId === storeId) latest = s;
      return latest;
    },
    recordSettings: async (tenantId, s) => {
      await input.store.append(tenantId, STORE_SETTINGS_STREAM, makeEvent({
        id: `store-settings-${s.storeId}-v${s.version}`, type: 'StoreSettingsSet', occurredAt: s.setAt,
        idempotencyKey: `store-settings-${tenantId}-${s.storeId}-v${s.version}`, source: 'api/platform', payload: s,
      }));
    },
  };
}

/** Where a person holds a permission — the branches of the grants that carry it (PA-01). */
export async function branchScopeHeldBy(store: EventStore, tenantId: string, userId: string, permission: string): Promise<readonly string[] | 'all' | undefined> {
  const grants = await effectiveGrants(store, tenantId);
  if (!grants.some((g) => g.userId === userId)) return undefined;
  return new AccessControl(ROLE_CATALOGUE, grants).branchScopeOf(userId, permission);
}

/**
 * Round 6 (EA-01): where a caller is a STORE COMPUTER — the stores NAMED by their `store_computer` role grants alone (a
 * person's other roles never count). undefined: they hold no store_computer grant.
 *
 * Round 7: a store computer reports only for the store(s) its grant names. A TENANT-WIDE store_computer grant names no
 * store, so it reports for none — it is never read as "every store" (one machine could otherwise speak for any store's
 * sync and holdings). Never 'all'.
 */
export async function storeComputerScopeHeldBy(store: EventStore, tenantId: string, userId: string): Promise<readonly string[] | undefined> {
  const grants = (await effectiveGrants(store, tenantId)).filter((g) => g.userId === userId && g.roleId === STORE_COMPUTER_ROLE_ID);
  if (grants.length === 0) return undefined;
  return [...new Set(grants.flatMap((g) => (g.branchScope === 'all' ? [] : g.branchScope)))].sort();
}

/** A store's working rules (DF-3-b-1): each change a `StoreRulesSet` version; the latest per store applies. */
const STORE_RULES_STREAM = streamName(STREAM.org, 'store-rules');
export function storeRulesAdapter(input: { readonly store: EventStore }): {
  rules: (tenantId: string, storeId: string) => Promise<StoreRules | undefined>;
  recordRules: (tenantId: string, r: StoreRules) => Promise<void>;
} {
  return {
    rules: async (tenantId, storeId) => {
      let latest: StoreRules | undefined;
      for (const r of await allOf<StoreRules>(input.store, tenantId, STORE_RULES_STREAM, 'StoreRulesSet')) if (r.storeId === storeId) latest = r;
      return latest;
    },
    recordRules: async (tenantId, r) => {
      await input.store.append(tenantId, STORE_RULES_STREAM, makeEvent({
        id: `store-rules-${r.storeId}-v${r.version}`, type: 'StoreRulesSet', occurredAt: r.setAt,
        idempotencyKey: `store-rules-${tenantId}-${r.storeId}-v${r.version}`, source: 'api/platform', payload: r,
      }));
    },
  };
}

/** Every count reconciliation head office holds, latest state per count (DF-3-b-2) — the same fold `countsAdapter` uses. */
export async function allCountReconciliations(store: EventStore, tenantId: string): Promise<readonly StoredReconciliation[]> {
  const countsStream = streamName(STREAM.inventory, 'counts');
  const byId = new Map<string, StoredReconciliation>();
  for (const r of await allOf<StoredReconciliation>(store, tenantId, countsStream, 'CountReconciled')) byId.set(r.countId, r);
  for (const d of await allOf<StoredReconciliation>(store, tenantId, countsStream, 'CountDecided')) byId.set(d.countId, d);
  return [...byId.values()];
}

/** What each store computer last said it holds (DF-3-b-2 · SF-08 hand-over): latest report per store. */
const HELD_VERSIONS_STREAM = streamName(STREAM.org, 'store-held-versions');
export function heldVersionsAdapter(input: { readonly store: EventStore }): {
  heldVersions: (tenantId: string, storeId: string) => Promise<HeldVersionsReport | undefined>;
  recordHeldVersions: (tenantId: string, r: HeldVersionsReport) => Promise<void>;
} {
  return {
    heldVersions: async (tenantId, storeId) => {
      let latest: HeldVersionsReport | undefined;
      for (const r of await allOf<HeldVersionsReport>(input.store, tenantId, HELD_VERSIONS_STREAM, 'StoreHeldVersionsReported')) if (r.storeId === storeId) latest = r;
      return latest;
    },
    recordHeldVersions: async (tenantId, r) => {
      // One report per (store, versions): the same versions said again collapse onto the first. A report that carries the
      // box's unsent count (PA-04) is an OBSERVATION at a moment — each one is kept, so the latest count is the one read.
      const observed = r.unsentItems === undefined ? '' : `-u${r.unsentItems}-${r.reportedAt}`;
      await input.store.append(tenantId, HELD_VERSIONS_STREAM, makeEvent({
        id: `held-${r.storeId}-${r.catalogueVersion ?? 'none'}-${r.storePackVersion ?? 'none'}${observed}`, type: 'StoreHeldVersionsReported', occurredAt: r.reportedAt,
        idempotencyKey: `held-${tenantId}-${r.storeId}-${r.catalogueVersion ?? 'none'}-${r.storePackVersion ?? 'none'}${observed}`, source: 'api/platform', payload: r,
      }));
    },
  };
}

// ── FUL-12: erasure over the REAL domain stores ──────────────────────────────────────────────────────────────────────

/** The append-only anonymisation facts a privacy erasure leaves in the customer domains (one per category per request). */
const PRIVACY_REDACTION_STREAM = streamName(STREAM.privacy, 'redactions');

interface CustomerDataAnonymised {
  readonly customerRef: string;
  readonly category: string;
  readonly requestId: string;
  /** The ref the domain's reads show instead of the person — unlinkable without the redaction record. */
  readonly anonymousRef: string;
  readonly at: string;
}

/** customerRef → anonymous ref, for every customer whose marketing profile an erasure anonymised. */
async function anonymisedProfiles(store: EventStore, tenantId: string): Promise<ReadonlyMap<string, string>> {
  const all = await allOf<CustomerDataAnonymised>(store, tenantId, PRIVACY_REDACTION_STREAM, 'CustomerDataAnonymised');
  return new Map(all.filter((r) => r.category === 'marketing_profile').map((r) => [r.customerRef, r.anonymousRef]));
}

/** The marker a minimised service case carries instead of the customer's own words. */
export const MINIMISED_TEXT = (requestId: string): string => `[removed under privacy request ${requestId}]`;

/**
 * The customer's holdings in the real domains (audit FUL-12 · M16-FR-03 · M20-FR-04). DEVELOPMENT-APPROVED; the
 * retention bases below are the product's working policy and still need the owner's authorisation and a lawyer's
 * confirmation before any real customer's data is erased (the matrix residual).
 *
 *   • marketing_profile — the order/complaint facts segmentation profiles from. Profiling has no legal hold: ERASED by
 *     anonymisation (an append-only fact; the segmentation reads then show an anonymous ref; totals survive).
 *   • service_cases — complaint handling is audit evidence, but the customer's own words are not needed to keep it:
 *     MINIMISED (each case's summary/resolution re-recorded as a redacted state; the case, its dates and SLA survive).
 *   • storefront_orders — tax invoices: RETAINED in full until the end of the eighth financial year after the last one.
 *   • consent_history — the proof of what the shop was permitted to do: RETAINED as audit evidence.
 */
export function privacyDomainHoldingsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /** ADR-0025: the per-subject data keys the personal fields are sealed under. Absent → nothing can be crypto-shredded. */
  readonly keys?: SubjectKeyStore;
}):
  (tenantId: string, customerRef: string) => Promise<readonly DomainHolding[]> {
  const cases = serviceCaseAdapter(input);
  /** Destroy one (customer, category) data key, and record the destruction as an append-only, audited fact (no key material). */
  const shredKey = async (tenantId: string, customerRef: string, category: string, requestId: string): Promise<void> => {
    if (input.keys === undefined) throw new Error(`no personal-data key store is configured, so ${category} cannot be crypto-shredded`);
    const at = input.now();
    const { alreadyShredded } = await input.keys.shred(tenantId, { subjectRef: customerRef, category }, { requestId, shreddedBy: 'api/privacy', at });
    await input.store.append(tenantId, PRIVACY_REDACTION_STREAM, makeEvent({
      id: `key-shredded-${requestId}-${category}`, type: 'SubjectDataKeyShredded', occurredAt: at,
      idempotencyKey: `key-shredded-${tenantId}-${requestId}-${category}`, source: 'api/privacy',
      payload: { customerRef, category, requestId, alreadyShredded, at },
    }));
  };
  const shredded = async (tenantId: string, customerRef: string, category: string): Promise<boolean> =>
    input.keys === undefined ? false : input.keys.isShredded(tenantId, { subjectRef: customerRef, category });
  const anonymousRefFor = (tenantId: string, customerRef: string, requestId: string): string =>
    `anon-${createHash('sha256').update(`${tenantId}|${customerRef}|${requestId}`).digest('hex').slice(0, 16)}`;
  const recordAnonymised = async (tenantId: string, r: CustomerDataAnonymised): Promise<void> => {
    await input.store.append(tenantId, PRIVACY_REDACTION_STREAM, makeEvent({
      id: `anonymised-${r.requestId}-${r.category}`, type: 'CustomerDataAnonymised', occurredAt: r.at,
      idempotencyKey: `anonymised-${tenantId}-${r.requestId}-${r.category}`, source: 'api/privacy', payload: r,
    }));
  };
  /** The eighth financial year after the latest invoice ends 31 March (Indian FY) — the working retention date. */
  const taxRetainUntil = (latestIso: string): string => {
    const d = new Date(latestIso);
    const fyEndYear = d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
    return `${fyEndYear + 8}-03-31`;
  };

  return async (tenantId, customerRef) => {
    const holdings: DomainHolding[] = [];

    // marketing_profile — counted on the RAW facts; once anonymised the domain reads no longer show the person.
    const anon = await anonymisedProfiles(input.store, tenantId);
    const orderFacts = (await allOf<OrderFact>(input.store, tenantId, ORDER_FACTS_STREAM, 'CustomerOrderFactRecorded')).filter((o) => o.customerRef === customerRef);
    const complaintFacts = (await allOf<ComplaintFact>(input.store, tenantId, COMPLAINT_FACTS_STREAM, 'CustomerComplaintFactRecorded')).filter((c) => c.customerRef === customerRef);
    const profileCount = new Set(orderFacts.map((o) => o.orderId)).size + new Set(complaintFacts.map((c) => c.caseId)).size;
    if (profileCount > 0) {
      holdings.push({
        category: 'marketing_profile', domain: 'customer segmentation', recordCount: anon.has(customerRef) ? 0 : profileCount,
        state: anon.has(customerRef) ? 'erased' : 'held',
        erase: async (requestId) => {
          await recordAnonymised(tenantId, { customerRef, category: 'marketing_profile', requestId, anonymousRef: anonymousRefFor(tenantId, customerRef, requestId), at: input.now() });
          return { recordsAffected: profileCount, note: `${profileCount} profile fact(s) anonymised in customer segmentation` };
        },
      });
    }

    // service_cases — minimised in place by a new, redacted state of each case.
    const mine = (await cases.serviceCases(tenantId)).filter((c) => c.customerRef === customerRef);
    if (mine.length > 0) {
      const redacted = (c: ServiceCase): boolean => c.summary.startsWith('[removed under privacy request');
      const open = mine.filter((c) => !redacted(c));
      holdings.push({
        category: 'service_cases', domain: 'service desk', recordCount: mine.length,
        retentionBasis: 'audit_evidence', minimisable: true, state: open.length === 0 ? 'minimised' : 'held',
        minimise: async (requestId) => {
          for (const c of open) {
            const next: ServiceCase = { ...c, summary: MINIMISED_TEXT(requestId), ...(c.resolution === undefined ? {} : { resolution: MINIMISED_TEXT(requestId) }) };
            await cases.recordCase(tenantId, c.caseId, next, `${c.caseId}-minimised-${requestId}`);
          }
          // ADR-0025: the customer's words in the EARLIER states of each case stay in the ledger as ciphertext — the key
          // they were sealed under is destroyed, so they can no longer be read. The redacted latest state is the record.
          if (input.keys !== undefined) await shredKey(tenantId, customerRef, 'service_cases', requestId);
          return { recordsAffected: open.length, note: `${open.length} service case(s) minimised — the customer's words removed, the case and its dates kept` };
        },
      });
    }

    // storefront_orders — tax invoices, kept in full.
    const orders = await allOf<PlacedOrder>(input.store, tenantId, forCustomerOrders(customerRef), 'OrderPlaced');
    if (orders.length > 0) {
      const latestAt = orders.map((o) => o.placedAt).sort().at(-1)!;
      holdings.push({ category: 'storefront_orders', domain: 'orders', recordCount: orders.length, retentionBasis: 'tax_invoice', retainUntil: taxRetainUntil(latestAt), state: 'held' });
    }

    // consent_history — the proof of permission, kept as audit evidence.
    const consents = await allOf<ConsentRecord>(input.store, tenantId, forCustomer(customerRef), 'ConsentRecorded');
    if (consents.length > 0) {
      holdings.push({ category: 'consent_history', domain: 'customer consent', recordCount: consents.length, retentionBasis: 'audit_evidence', state: 'held' });
    }

    // ADR-0025 — the holdings whose personal text is SEALED under the customer's own data key. Erasing one destroys that
    // key: the records (when, which channel, what it cost, the cash taken) stay; the words become unreadable ciphertext.
    const crypto = async (category: string, domain: string, recordCount: number): Promise<void> => {
      if (recordCount === 0) return;
      const gone = await shredded(tenantId, customerRef, category);
      holdings.push({
        category, domain, recordCount: gone ? 0 : recordCount, state: gone ? 'erased' : 'held',
        // No key store → the holding is still LOCATED, and an erasure of it is a visible exception (P-08), never a silent success.
        ...(input.keys === undefined ? {} : {
          erase: async (requestId: string) => {
            await shredKey(tenantId, customerRef, category, requestId);
            return { recordsAffected: recordCount, note: `${recordCount} record(s) in ${domain}: the personal text's key destroyed; the records themselves kept` };
          },
        }),
      });
    };
    // notification_intents — the words of each message queued to this customer (PA-08). No law keeps marketing words.
    const queued = (await allOf<NotificationQueueEvent>(input.store, tenantId, streamName(STREAM.org, 'notifications'), 'NotificationQueue'))
      .filter((e) => e.change === 'enqueued' && e.intent?.customerId === customerRef);
    await crypto('notification_intents', 'notifications', queued.length);
    // loyalty_member — the member record (the last four digits of the number) where this customer IS the member code.
    const member = (await allOf<MemberRecord>(input.store, tenantId, LOYALTY_MEMBERS, 'LoyaltyMember')).filter((m) => m.memberRef === customerRef);
    await crypto('loyalty_member', 'loyalty', member.length);
    // delivery_records — the driver's notes at this customer's door and the stop's area label on the day's dispatch plan.
    const myOrders = new Set(orders.map((o) => o.orderId));
    let deliveryRecords = 0;
    for (const orderId of myOrders) {
      deliveryRecords += (await allOf<DeliveryAttempt>(input.store, tenantId, forOrderAttempts(orderId), 'DeliveryAttemptIndexed')).length;
    }
    await crypto('delivery_records', 'delivery', deliveryRecords);
    // lp_records — a loss-prevention case naming this person: kept in full for the investigation (its key is kept too).
    const lp = (await input.store.readStream(tenantId, STREAM.lossPrevention)).filter((e) => e.event.type === 'LpCaseOpened' && (e.event.payload as InvestigationCase).subjectRef === customerRef);
    if (lp.length > 0) {
      holdings.push({ category: 'lp_records', domain: 'loss prevention', recordCount: lp.length, retentionBasis: 'fraud_investigation', state: 'held' });
    }
    return holdings;
  };
}

// ── PF-10: campaign send — frequency history from the PA-08 queue, the queue's enqueue, delivery reports ─────────────

const CAMPAIGN_SEND_STREAM = streamName(STREAM.service, 'campaign-sends');
const CAMPAIGN_FREQUENCY_STREAM = streamName(STREAM.service, 'campaign-frequency');
const CAMPAIGN_DELIVERY_STREAM = streamName(STREAM.service, 'campaign-delivery');

export function campaignSendAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly deliveryReportSecrets?: ReadonlyMap<string, string> }): CampaignSendDeps {
  // The SAME queue, template register and consent ledger the PA-08 routes use — one record each (P-02).
  const q = notificationQueueAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    // PF-10 r6: delivery reports — the providers' secrets (from the environment) and the relay's own machine identity.
    ...(input.deliveryReportSecrets === undefined ? {} : { deliveryReportSecrets: input.deliveryReportSecrets }),
    isProviderRelay: async (tenantId, userId) => (await effectiveGrants(input.store, tenantId)).some((g) => g.userId === userId && g.roleId === PROVIDER_RELAY_ROLE_ID),
    consentRecords: (tenantId, customerId) => allOf<ConsentRecord>(input.store, tenantId, forCustomer(customerId), 'ConsentRecorded'),
    templates: q.templates!,
    queueEvents: q.events!,
    queue: q.queue,
    enqueue: q.record,
    frequencyPolicy: (tenantId) => latest<CampaignFrequencyPolicy>(input.store, tenantId, CAMPAIGN_FREQUENCY_STREAM, 'CampaignFrequencyPolicySet'),
    recordFrequencyPolicy: async (tenantId, p) => {
      await input.store.append(tenantId, CAMPAIGN_FREQUENCY_STREAM, makeEvent({
        id: keyedEventId('campaign-frequency', `campaign-frequency-${tenantId}-${p.capPerWindow}-${p.windowDays}-${p.setAt}`), type: 'CampaignFrequencyPolicySet', occurredAt: p.setAt,
        idempotencyKey: `campaign-frequency-${tenantId}-${p.capPerWindow}-${p.windowDays}-${p.setAt}`, source: 'api/customer', payload: p,
      }));
    },
    sends: async (tenantId, campaignId) =>
      (await allOf<CampaignSendRecord>(input.store, tenantId, CAMPAIGN_SEND_STREAM, 'CampaignSent')).filter((s) => s.campaignId === campaignId),
    recordSend: async (tenantId, r, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, CAMPAIGN_SEND_STREAM, makeEvent({
        id: `campaign-send-${r.campaignId}-${d}`, type: 'CampaignSent', occurredAt: r.at,
        idempotencyKey: `campaign-send-${tenantId}-${r.campaignId}-${d}`, source: 'api/customer', payload: r,
      }));
    },
    callbacks: async (tenantId, campaignId) =>
      (await allOf<DeliveryCallback>(input.store, tenantId, CAMPAIGN_DELIVERY_STREAM, 'CampaignDeliveryReported')).filter((c) => c.campaignId === campaignId),
    recordCallback: async (tenantId, c, key) => {
      const d = createHash('sha256').update(key).digest('hex').slice(0, 16);
      await input.store.append(tenantId, CAMPAIGN_DELIVERY_STREAM, makeEvent({
        id: `campaign-delivery-${c.messageId}-${d}`, type: 'CampaignDeliveryReported', occurredAt: c.recordedAt,
        // A provider re-sending the same report collapses; a new status (delivered → read) is a new, append-only fact.
        idempotencyKey: `campaign-delivery-${tenantId}-${d}`, source: 'api/customer', payload: c,
      }));
    },
  };
}

// ── EA-08: the governed model call — admission, reservation, metering, immutable audit ──────────────────────────────

export function modelGatewayAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly transport?: ModelTransport;
  readonly pricing?: Readonly<Record<ModelTier, TierPricing>>;
  /** EA-08: the agent's governed evidence, read server-side from its domain readers. */
  readonly evidenceFor?: ModelGatewayDeps['evidenceFor'];
}): ModelGatewayDeps {
  const ai = aiAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    killSwitchOn: ai.killSwitchOn,
    enabledAgents: ai.enabledAgents,
    budget: ai.budget,
    openReservedMinor: async (tenantId) => {
      const reserved = await allOf<{ readonly callId: string; readonly amountMinor: number }>(input.store, tenantId, STREAM.ai, 'AiCostReserved');
      const settled = new Set((await allOf<{ readonly runId: string }>(input.store, tenantId, STREAM.ai, 'AiRunCosted')).map((c) => c.runId));
      return reserved.filter((r) => !settled.has(r.callId)).reduce((t, r) => t + r.amountMinor, 0);
    },
    reserve: async (tenantId, r) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({ id: `ai-reserve-${r.callId}`, type: 'AiCostReserved', occurredAt: r.at, idempotencyKey: `ai-reserve-${tenantId}-${r.callId}`, source: 'api/ai', payload: r }));
    },
    settle: async (tenantId, s) => {
      // The SAME AiRunCosted fact the budget sums — the actual, metered cost, keyed on the call.
      await input.store.append(tenantId, STREAM.ai, makeEvent({ id: `ai-cost-${s.callId}`, type: 'AiRunCosted', occurredAt: s.at, idempotencyKey: `ai-cost-${tenantId}-${s.callId}`, source: 'api/ai', payload: { runId: s.callId, agent: s.agent, costMinor: s.actualMinor, reservedMinor: s.reservedMinor, calledAModel: true } }));
    },
    audits: (tenantId) => allOf<ModelCallAudit>(input.store, tenantId, streamName(STREAM.ai, 'model-calls'), 'AiModelCallAudited'),
    appendAudit: async (tenantId, a) => {
      await input.store.append(tenantId, streamName(STREAM.ai, 'model-calls'), makeEvent({ id: `ai-model-call-${a.callId}`, type: 'AiModelCallAudited', occurredAt: a.at, idempotencyKey: `ai-model-call-${tenantId}-${a.callId}`, source: 'api/ai', payload: a }));
    },
    ...(input.pricing === undefined ? {} : { pricing: () => input.pricing }),
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    ...(input.evidenceFor === undefined ? {} : { evidenceFor: input.evidenceFor }),
  };
}

/**
 * FUL-11 (M04-FR-01 · P-02): every product head office's stock ledger has ever recorded SELLING at a store — the store's own
 * id and every location the org hierarchy places under it. The range integrity check reads this beside what the till reports.
 */
export function storeStockFactsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /** Which branch a location belongs to (the org hierarchy); absent → a location is its own store. */
  readonly branchOf?: (tenantId: string) => Promise<(locationId: string) => string> | ((locationId: string) => string);
}): {
  readonly soldAtStore: (tenantId: string, storeId: string) => Promise<readonly string[]>;
} {
  return {
    soldAtStore: async (tenantId, storeId) => {
      const of = input.branchOf === undefined ? (l: string) => l : await input.branchOf(tenantId);
      const sold = new Set<string>();
      for (const e of await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })) {
        const m = payloadOf<Movement>(e);
        if (m.kind === 'sold' && (m.locationId === storeId || of(m.locationId) === storeId)) sold.add(m.productId);
      }
      return [...sold].sort();
    },
  };
}

/**
 * FUL-11 (round 6 · M09-FR-02 · M04-FR-01): the facts a store's replenishment proposal runs on — head office's, never the
 * request's. On-hand from the stock position at the store and every place under it; on-order from the ISSUED purchase
 * orders delivered there (ordered − received − cancelled); in transit from the transfers on the van to it; sold from the
 * ledger's `sold` movements at those places in the window.
 */
export function replenishmentFactsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly branchOf?: (tenantId: string) => Promise<(locationId: string) => string> | ((locationId: string) => string);
}): {
  readonly storeFacts: (tenantId: string, storeId: string) => Promise<StoreReplenishmentFacts>;
  readonly soldLines: (tenantId: string, storeId: string, fromIso: string, toIso: string) => Promise<readonly SoldLine[]>;
} {
  const placeOf = async (tenantId: string) => {
    const of = input.branchOf === undefined ? (l: string) => l : await input.branchOf(tenantId);
    return (storeId: string, locationId: string) => locationId === storeId || of(locationId) === storeId;
  };
  return {
    storeFacts: async (tenantId, storeId) => {
      const at = await placeOf(tenantId);
      const inv = inventoryAdapter(input);
      const onHand: Record<string, number> = {};
      const places = new Set<string>([storeId]);
      for (const r of await inv.availability(tenantId)) {
        if (at(storeId, r.locationId)) { onHand[r.productId] = (onHand[r.productId] ?? 0) + r.onHandMinor; places.add(r.locationId); }
      }
      // FUL-11 round 7: the holds still standing at the store's places — online orders (FUL-02) and B2B orders (FUL-09).
      const reserved: Record<string, number> = {};
      for (const place of places) {
        for (const r of await outstandingReservationsAt(input.store, tenantId, place, input.now())) reserved[r.productId] = (reserved[r.productId] ?? 0) + r.quantityMinor;
      }
      const inTransit: Record<string, number> = {};
      for (const r of await inv.inTransit!(tenantId)) {
        if (at(storeId, r.locationId)) inTransit[r.productId] = (inTransit[r.productId] ?? 0) + r.quantityMinor;
      }
      const onOrder: Record<string, number> = {};
      const of = input.branchOf === undefined ? (l: string) => l : await input.branchOf(tenantId);
      for (const d of openDeliveriesFor(await purchaseOrdersAdapter(input).all(tenantId), storeId, of)) {
        for (const l of d.lines) onOrder[l.productId] = (onOrder[l.productId] ?? 0) + l.openQty;
      }
      return { onHand, onOrder, inTransit, reserved };
    },
    soldLines: async (tenantId, storeId, fromIso, toIso) => {
      const at = await placeOf(tenantId);
      const out: SoldLine[] = [];
      for (const e of await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved', from: fromIso, to: toIso })) {
        const m = payloadOf<Movement>(e);
        if (m.kind === 'sold' && at(storeId, m.locationId)) out.push({ productId: m.productId, quantityMinor: m.quantityMinor, tradingDay: m.occurredAt.slice(0, 10) });
      }
      return out;
    },
  };
}

/**
 * FUL-11 (M04-FR-04 · D02-FR-06 · M23): supplier display funding — the contracts merchandising recorded, and the receipts finance
 * posted as journals through the accountant's mapping (a receipt IS its journal, on the one finance stream).
 */
export function displayFundingAdapter(input: { readonly store: EventStore; readonly now: () => string }): DisplayFundingDeps & {
  readonly fundingReceived: (tenantId: string) => Promise<Readonly<Record<string, Money>>>;
} {
  const fin = financeAdapter(input);
  const fundingJournals = async (tenantId: string): Promise<readonly DisplayFundingJournal[]> =>
    (await allOf<JournalEntry | DisplayFundingJournal>(input.store, tenantId, STREAM.finance, 'JournalPosted'))
      .filter((j): j is DisplayFundingJournal => 'displayFunding' in j);
  return {
    periodStates: fin.periodStates,
    nextOpenPeriod: fin.nextOpenPeriod,
    appendJournal: fin.appendJournal,
    now: input.now,
    postingMap: (tenantId) => latest<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined'),
    contracts: (tenantId) => spacePerformanceAdapter(input).contracts(tenantId),
    fundingJournals,
    fundingReceived: async (tenantId) => {
      const out: Record<string, Money> = {};
      for (const j of await fundingJournals(tenantId)) {
        const id = j.displayFunding.contractId;
        out[id] = { minor: (out[id]?.minor ?? 0) + j.displayFunding.amountMinor, currency: 'INR' };
      }
      return out;
    },
  };
}

/**
 * FUL-03: head office's own delivery service — where the store is, its daily slots — and the slot bookings, each slot on
 * its own write guard so the last place is taken once. The configuration is append-only, the latest in force; a booking
 * stops counting once its order is cancelled (or was never placed, after a short grace for a placement in flight).
 */
export function deliveryServiceAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly timeZone: (tenantId: string) => Promise<string> | string;
}): DeliveryServiceDeps {
  const configStream = streamName(STREAM.delivery, 'service');
  const slotStream = (startsAt: string): string => streamName(STREAM.delivery, 'slot', startsAt.replace(/[^0-9TZ]/g, ''));
  const guardKey = (startsAt: string): string => `delivery-slot:${startsAt}`;
  const orders = ordersAdapter({ store: input.store, now: input.now, holdMinutes: 30 });
  return {
    now: input.now,
    timeZone: input.timeZone,
    config: async (tenantId) => (await allOf<DeliveryServiceConfig>(input.store, tenantId, configStream, 'DeliveryServiceSet')).at(-1),
    recordConfig: async (tenantId, c, key) => {
      await input.store.append(tenantId, configStream, makeEvent({
        id: `delivery-service-${key}`, type: 'DeliveryServiceSet', occurredAt: c.setAt,
        idempotencyKey: `delivery-service-${tenantId}-${key}`, source: 'api/orders', payload: c,
      }));
    },
    policyOn: async (tenantId, day) => resolveServiceabilityPolicy({ schedule: await serviceabilityAdapter(input).schedule(tenantId), on: day }).policy,
    slotVersion: (tenantId, startsAt) => input.store.guardVersion(tenantId, guardKey(startsAt)),
    bookings: (tenantId, startsAt) => allOf<SlotBooking>(input.store, tenantId, slotStream(startsAt), 'DeliverySlotBooked'),
    recordBooking: async (tenantId, b, expectedVersion) => {
      await input.store.appendBatch(tenantId, [{ stream: slotStream(b.slotStartsAt), event: makeEvent({
        id: `slot-booking-${b.orderId}`, type: 'DeliverySlotBooked', occurredAt: b.bookedAt,
        idempotencyKey: `slot-booking-${tenantId}-${b.orderId}`, source: 'api/orders', payload: b,
      }) }], { guard: { key: guardKey(b.slotStartsAt), expectedVersion } });
    },
    releasedOrder: async (tenantId, orderId, bookedAt) => {
      const placed = await orders.placedOrder(tenantId, orderId);
      if (placed === undefined) return Date.parse(input.now()) - Date.parse(bookedAt) > 2 * 60_000;
      return (await orders.orderState(tenantId, orderId))?.state === 'cancelled';
    },
  };
}

/**
 * FUL-09: a B2B sales order's stock — the ORDINARY stock every channel sells from (P-02). The order's lines are held at
 * its store under the same per-store promise guard the online orders use (so two orders never promise the last unit),
 * all or nothing; a challan takes what left the building off the shelf as ordinary `sold` movements keyed on the challan
 * line (once, however often it is re-sent), and in the same guarded batch the order's old holds are released and what is
 * still to go is held again. A B2B hold does not lapse: it stands until the goods leave.
 */
export function b2bStockAdapter(input: { readonly store: EventStore; readonly now: () => string }): B2BStockPort {
  const NEVER = '9999-12-31T23:59:59.999Z';
  const inv = inventoryAdapter(input);
  const orders = ordersAdapter({ store: input.store, now: input.now, holdMinutes: 0 });
  const heldFor = async (tenantId: string, orderRef: string, locationId: string): Promise<readonly Reservation[]> =>
    (await outstandingReservationsAt(input.store, tenantId, locationId, input.now())).filter((r) => r.orderId === orderRef);
  return {
    reserve: async (tenantId, orderRef, locationId, lines) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if ((await heldFor(tenantId, orderRef, locationId)).length > 0) return { ok: true };
        const version = await input.store.guardVersion(tenantId, reservationGuardKey(locationId));
        const onHand = new Map<string, number>();
        for (const l of lines) {
          const rows = await inv.availability(tenantId, l.productId);
          onHand.set(l.productId, rows.find((r) => r.productId === l.productId && r.locationId === locationId)?.onHandMinor ?? 0);
        }
        const result = promiseStock({
          orderId: orderRef, lines, onHand, outstanding: await outstandingReservationsAt(input.store, tenantId, locationId, input.now()),
          locationId, heldUntil: NEVER, reservationIdFor: (o, p) => `${o}-${p}`,
        });
        const short = result.lines.filter((l) => l.promisedMinor < l.requestedMinor);
        if (short.length > 0) return { ok: false, shortages: short.map((l) => ({ productId: l.productId, requestedMinor: l.requestedMinor, promisedMinor: l.promisedMinor })) };
        try {
          await orders.holdReservations(tenantId, result.lines.flatMap((l) => (l.reservation === undefined ? [] : [l.reservation])), version);
          return { ok: true };
        } catch (err) {
          if (!(err instanceof ConcurrencyConflictError)) throw err;
        }
      }
      throw new ConcurrencyConflictError(reservationGuardKey(locationId), -1);
    },
    dispatch: async (tenantId, d) => {
      const at = input.now();
      const uomOf = async (productId: string): Promise<string> => {
        const unit = (await posAdapter({ store: input.store, now: input.now }).catalogue(tenantId)).get(productId)?.baseUom;
        return unit === undefined ? 'ea' : normaliseUom(unit) ?? unit;
      };
      // 1 · What left the building comes off the shelf, once per challan line.
      for (const l of d.lines) {
        await inv.appendMovement(tenantId, {
          movementId: `b2b-dispatch-${d.orderRef}-${d.challanId}-${l.lineId}`, productId: l.productId, locationId: d.locationId,
          kind: 'sold', quantityMinor: l.quantityMinor, uom: await uomOf(l.productId), occurredAt: at, enteredBy: d.by,
          reason: `B2B challan ${d.challanId} for ${d.orderRef}`,
        });
      }
      // 2 · The order's holds are released and what is still to go held again — one guarded batch, so nothing is unheld
      //     in between for another order to take.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const version = await input.store.guardVersion(tenantId, reservationGuardKey(d.locationId));
        const current = await heldFor(tenantId, d.orderRef, d.locationId);
        if (current.some((r) => r.reservationId.endsWith(`@${d.challanId}`))) return; // this challan's re-hold is already done
        const rehold: Reservation[] = d.remaining.map((r) => ({
          reservationId: `${d.orderRef}-${r.productId}@${d.challanId}`, orderId: d.orderRef, productId: r.productId,
          quantityMinor: r.quantityMinor, locationId: d.locationId, heldUntil: NEVER,
        }));
        try {
          await input.store.appendBatch(tenantId, [
            ...current.map((r) => ({ stream: forLocation(r.locationId), event: makeEvent({
              id: `res-rel-${r.reservationId}`, type: 'ReservationReleased', occurredAt: at, idempotencyKey: `res-rel-${tenantId}-${r.reservationId}`, source: 'api/b2b',
              payload: { reservationId: r.reservationId, orderId: r.orderId, productId: r.productId, locationId: r.locationId, at },
            }) })),
            ...rehold.map((r) => ({ stream: forLocation(r.locationId), event: makeEvent({
              id: `res-${r.reservationId}`, type: 'ReservationHeld', occurredAt: at, idempotencyKey: `res-${tenantId}-${r.reservationId}`, source: 'api/b2b', payload: r,
            }) })),
          ], { guard: { key: reservationGuardKey(d.locationId), expectedVersion: version } });
          return;
        } catch (err) {
          if (!(err instanceof ConcurrencyConflictError)) throw err;
        }
      }
      throw new ConcurrencyConflictError(reservationGuardKey(d.locationId), -1);
    },
    held: async (tenantId, orderRef, locationId) => {
      const byProduct = new Map<string, number>();
      for (const r of await heldFor(tenantId, orderRef, locationId)) byProduct.set(r.productId, (byProduct.get(r.productId) ?? 0) + r.quantityMinor);
      return [...byProduct].map(([productId, quantityMinor]) => ({ productId, quantityMinor }));
    },
  };
}

/** FUL-09 · M22-FR-03: salesperson commission rules — proposed, then approved by another; append-only, the latest approved in force. */
export function commissionRuleAdapter(input: { readonly store: EventStore; readonly now: () => string }): CommissionRuleDeps {
  const stream = (salespersonId: string): string => streamName('b2b-commission-rules', salespersonId);
  const accruals = b2bCommissionAdapter(input);
  return {
    now: input.now,
    rules: (tenantId, salespersonId) => allOf<CommissionRule>(input.store, tenantId, stream(salespersonId), 'B2BCommissionRuleRecorded'),
    recordRule: async (tenantId, r) => {
      const stage = r.approvedBy === undefined ? 'proposed' : 'approved';
      await input.store.append(tenantId, stream(r.salespersonId), makeEvent({
        id: `b2b-comm-rule-${r.ruleId}-${stage}`, type: 'B2BCommissionRuleRecorded', occurredAt: r.approvedAt ?? r.proposedAt,
        idempotencyKey: `b2b-comm-rule-${tenantId}-${r.salespersonId}-${r.ruleId}-${stage}`, source: 'api/finance', payload: r,
      }));
    },
    accruals: accruals.accruals,
    recordAccrual: accruals.recordAccrual,
  };
}

/** FUL-09: the B2B portal's quote requests, and the recurring orders with their runs — each its own append-only stream. */
export function b2bOrderingAdapter(input: { readonly store: EventStore; readonly now: () => string }): Pick<B2BOrderingDeps, 'quoteRequests' | 'recordQuoteRequest' | 'schedules' | 'recordSchedule' | 'runs' | 'recordRun' | 'now'> {
  const requests = streamName('b2b-ordering', 'quote-requests');
  const schedules = streamName('b2b-ordering', 'recurring');
  const runs = streamName('b2b-ordering', 'recurring-runs');
  return {
    now: input.now,
    quoteRequests: (tenantId) => allOf<B2BQuoteRequest>(input.store, tenantId, requests, 'B2BQuoteRequested'),
    recordQuoteRequest: async (tenantId, r) => {
      await input.store.append(tenantId, requests, makeEvent({
        id: `b2b-qr-${r.requestId}`, type: 'B2BQuoteRequested', occurredAt: r.at, idempotencyKey: `b2b-qr-${tenantId}-${r.requestId}`, source: 'api/finance', payload: r,
      }));
    },
    schedules: (tenantId) => allOf<RecurringSchedule>(input.store, tenantId, schedules, 'B2BRecurringOrderRecorded'),
    recordSchedule: async (tenantId, s) => {
      const stage = s.approvedBy === undefined ? 'proposed' : 'approved';
      await input.store.append(tenantId, schedules, makeEvent({
        id: `b2b-rec-${s.scheduleId}-${stage}`, type: 'B2BRecurringOrderRecorded', occurredAt: s.approvedAt ?? s.proposedAt,
        idempotencyKey: `b2b-rec-${tenantId}-${s.scheduleId}-${stage}`, source: 'api/finance', payload: s,
      }));
    },
    runs: (tenantId) => allOf<RecurringRun>(input.store, tenantId, runs, 'B2BRecurringOrderRun'),
    recordRun: async (tenantId, r) => {
      await input.store.append(tenantId, runs, makeEvent({
        id: keyedEventId('b2b-run', r.outcome === 'generated' ? `b2b-run-${tenantId}-${r.scheduleId}-${r.on}-generated` : `b2b-run-${tenantId}-${r.scheduleId}-${r.on}-${r.at}`), type: 'B2BRecurringOrderRun', occurredAt: r.at,
        // A generated day is one fact; an exception is recorded each time the day is tried and fails.
        idempotencyKey: r.outcome === 'generated' ? `b2b-run-${tenantId}-${r.scheduleId}-${r.on}-generated` : `b2b-run-${tenantId}-${r.scheduleId}-${r.on}-${r.at}`,
        source: 'api/finance', payload: r,
      }));
    },
  };
}


/** EA-01 (round 4): the branches head office knows, and each store computer's own last report for sales. */
export interface StoreSyncView {
  readonly branches: ReadonlyMap<string, string>;
  readonly sales: ReadonlyMap<string, StoreSyncReport>;
}

/** Read the store computers' sync reports into the view the reporting adapters merge (latest report per store). */
export async function storeSyncView(store: EventStore, tenantId: string, now: () => string): Promise<StoreSyncView> {
  const branches = new Map((await orgStructureAdapter({ store, now }).nodes(tenantId)).filter((n) => n.kind === 'branch').map((n) => [n.nodeId, n.name] as const));
  return { branches, sales: latestDomainReports(await syncWatermarksAdapter({ store }).records(tenantId), 'sales') };
}

/**
 * Merge the sales sources head office derives from the sales it holds with each store computer's own watermark report
 * (EA-01 round 4): a store's time is the later of the two; a store that reported but has no sales is listed by its
 * report; a branch head office knows but has never heard from is listed, stale — never left out. `scope` limits the
 * stores listed to the reader's branches (lane sources pass through as before).
 */
export function mergeStoreSync(
  marks: readonly { readonly source: string; readonly lastEventAt: string | null }[],
  view: StoreSyncView,
  now: string,
  thresholds: { readonly laggingAfterMinutes?: number; readonly staleAfterMinutes?: number },
  scope: BranchScope,
): readonly SourceFreshness[] {
  const inScope = (id: string): boolean => scope === 'all' || scope.includes(id);
  const newest = new Map<string, string | null>(marks.map((m) => [m.source, m.lastEventAt] as const));
  for (const id of view.sales.keys()) if (inScope(id) && !newest.has(`store:${id}`)) newest.set(`store:${id}`, null);
  for (const id of view.branches.keys()) if (inScope(id) && !newest.has(`store:${id}`)) newest.set(`store:${id}`, null);
  if (newest.size === 0) return [sourceFreshness({ source: 'any till', domain: 'sales', lastEventAt: null, now, ...thresholds })];
  return [...newest.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([source, lastEventAt]) => {
    const reported = source.startsWith('store:') ? view.sales.get(source.slice('store:'.length)) : undefined;
    return sourceFreshness({ source, domain: 'sales', lastEventAt, now, ...thresholds, ...(reported === undefined ? {} : { reported }) });
  });
}


/** M35-FR-03: every health report each store computer made (append-only; the latest per store is read). */
const BOX_HEALTH_STREAM = streamName(STREAM.org, 'store-computer-health');
/** Verifier r21 BOX-2: a person's acknowledgements of refused box reports (append-only). */
const BOX_REFUSAL_ACK_STREAM = streamName(STREAM.org, 'store-computer-refusal-acknowledgements');
/** Round 26 · OB-97: owner-approved "store computer replaced" acts (append-only). */
const BOX_REPLACEMENT_STREAM = streamName(STREAM.org, 'store-computer-replacements');
/** Round 26 · OB-98: acknowledgements of an "at-risk numbers not checked" finding (append-only). */
const BOX_AT_RISK_ACK_STREAM = streamName(STREAM.org, 'store-computer-not-checked-acknowledgements');
/** Round 28 · OB-103: acknowledgements of a "said unused, but head office has the bill" finding (append-only). */
const BOX_UNUSED_ACK_STREAM = streamName(STREAM.org, 'store-computer-unused-received-acknowledgements');
/** Round 26 · OB-97: the guard one (store, prefix)'s binding moves under — two acts racing on it cannot both land. */
const bindingGuardKey = (storeId: string, prefix: string): string => `store-computer-binding:${storeId}:${prefix}`;
export function boxHealthAdapter(input: {
  readonly store: EventStore; readonly snapshots?: SnapshotStore;
  /**
   * Round 28 · OB-103/104: the owner's settings the health read uses (the same saved running result is shared, and is set
   * aside when read with other settings — so give the same ones the health read gets).
   */
  readonly settings?: StoreComputerReadingSettings;
  readonly now?: () => string;
  /** Round 29 · OB-106: how long a route waits for the store computers' history being built before answering 503 "being prepared". */
  readonly waitMs?: number;
  /** Round 30 · OB-111: the key the saved history is sealed with (`boxHistorySealKey`). */
  readonly boxHistorySealKey?: BoxHistorySealKey;
}): {
  records: (tenantId: string) => Promise<readonly BoxHealthRecord[]>;
  acknowledgeUnusedReceived: (tenantId: string, a: UnusedReceivedAcknowledgement, requestKey: string) => Promise<UnusedReceivedAcknowledgement>;
  unusedReceivedNow: (tenantId: string, storeId: string, prefix: string) => Promise<readonly (readonly [number, number])[]>;
  bindingsAt: (tenantId: string, at: string) => Promise<readonly PrefixBinding[]>;
  refusedReportHeld: (tenantId: string, storeId: string, prefix: string, through: number, at: string) => Promise<boolean>;
  latestNamedAt: (tenantId: string, storeId: string, prefix: string, at: string) => Promise<IssuedReport | undefined>;
  record: (tenantId: string, r: BoxHealthRecord) => Promise<BoxHealthRecord>;
  acknowledge: (tenantId: string, a: RefusalAcknowledgement, requestKey: string) => Promise<RefusalAcknowledgement>;
  issuedAndBanked: (tenantId: string) => Promise<{ issuedPrefixes: ReadonlyMap<string, ReadonlySet<string>>; banked: ReadonlyMap<string, number> }>;
  replacements: (tenantId: string) => Promise<readonly StoreComputerReplacement[]>;
  bindingVersion: (tenantId: string, storeId: string, prefix: string) => Promise<number>;
  recordReplacement: (tenantId: string, m: StoreComputerReplacement, expectedVersion: number) => Promise<StoreComputerReplacement>;
  acknowledgeNotChecked: (tenantId: string, a: AtRiskAcknowledgement, requestKey: string) => Promise<AtRiskAcknowledgement>;
  recordsBetween: (tenantId: string, from: string, to: string) => Promise<readonly BoxHealthRecord[]>;
  lanePrefixRegistrations: (tenantId: string) => Promise<readonly LanePrefixRegistration[]>;
  registerLanePrefixes: (tenantId: string, r: LanePrefixRegistration, key: string) => Promise<LanePrefixRegistration>;
  countRefusedAtDoor: (tenantId: string, r: { readonly computer: string; readonly storeId: string; readonly at: string; readonly prefixes: readonly string[] }) => Promise<void>;
  refusedAtDoorLines: (tenantId: string) => Promise<readonly DoorRefusalLine[]>;
  registeredTills: (tenantId: string) => Promise<readonly { readonly storeId: string; readonly tillId: string }[]>;
} {
  const reading = async (tenantId: string, at: string) => {
    const r = await storeComputerHistory(input.store, tenantId, at, {
      ...(input.settings === undefined ? {} : await readingSettings(input.settings, tenantId)),
      ...(input.snapshots === undefined ? {} : { snapshots: input.snapshots }),
      ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
      ...(input.boxHistorySealKey === undefined ? {} : { sealKey: input.boxHistorySealKey }),
    });
    // Round 29 · OB-106: not ready yet — the routes answer 503 "being prepared" (nothing is guessed, nothing recorded).
    if (r.preparing !== undefined) throw new BoxHistoryPreparing(r.preparing.since, r.preparing.why);
    return r;
  };
  return {
    // Round 33 · OB-121: the store computers' registered lane prefixes, and the reports refused at the door.
    lanePrefixRegistrations: (tenantId) => lanePrefixRegistrationsOf(input.store, tenantId),
    registerLanePrefixes: async (tenantId, r, key) => {
      const res = await input.store.append(tenantId, LANE_PREFIX_STREAM, lanePrefixRegistrationEvent(tenantId, r, key, 'api/platform'));
      return res.record.event.payload as LanePrefixRegistration;
    },
    countRefusedAtDoor: (tenantId, r) => countRefusedAtDoor(input.store, tenantId, r),
    refusedAtDoorLines: (tenantId) => refusedAtDoorLines(input.store, tenantId),
    registeredTills: receiptPrefixAdapter({ store: input.store, now: input.now ?? (() => new Date().toISOString()) }).registeredTills!,
    // Round 28 · OB-103: EACH acknowledgement is its own record (who, why, when); only a re-sent request answers the first.
    acknowledgeUnusedReceived: async (tenantId, a, requestKey) => {
      const request = createHash('sha256').update(requestKey).digest('hex').slice(0, 32);
      const key = `box-unused-received-ack-${tenantId}-${a.storeId}-${a.prefix}-${request}`;
      const res = await input.store.append(tenantId, BOX_UNUSED_ACK_STREAM, makeEvent({
        id: keyedEventId('box-unused-received-ack', key), type: 'BoxUnusedReceivedAcknowledged', occurredAt: a.at, idempotencyKey: key, source: 'api/platform', payload: a,
      }));
      return res.record.event.payload as UnusedReceivedAcknowledgement;
    },
    // Round 28 · OB-103: the line as the health read finds it now (before any acknowledgement silences it), from the same reading.
    unusedReceivedNow: async (tenantId, storeId, prefix) => {
      const r = await reading(tenantId, (input.now ?? (() => new Date().toISOString()))());
      return [...(r.unusedReceived.get(storeId) ?? [])].filter((u) => u.prefix === prefix).map((u) => [u.number, u.number] as const);
    },
    // Round 28 · OB-104: the bindings on the reports as kept (`prefixBindings`), from the saved running result.
    bindingsAt: async (tenantId, at) => (await reading(tenantId, at)).rawBindings,
    // Round 34 · OB-104 / OB-124 (4): the three rare person acts read the saved running result and the reports after it only.
    refusedReportHeld: async (tenantId, storeId, prefix, through, at) => {
      const r = await reading(tenantId, at);
      if (r.facts?.(storeId).refusedOpen.some(([p, open]) => p === prefix && open.has(through)) === true) return true;
      // Acknowledged before (a person may acknowledge the same count again — each its own record, r22 D2): the report was held.
      return (await allOf<RefusalAcknowledgement>(input.store, tenantId, BOX_REFUSAL_ACK_STREAM, 'BoxReportRefusalAcknowledged'))
        .some((a) => a.storeId === storeId && a.prefix === prefix && a.through === through && a.authority === 'all_stores');
    },
    latestNamedAt: async (tenantId, storeId, prefix, at) => (await reading(tenantId, at)).facts?.(storeId).latestNamed(prefix),
    replacements: (tenantId) => allOf<StoreComputerReplacement>(input.store, tenantId, BOX_REPLACEMENT_STREAM, 'StoreComputerReplaced'),
    bindingVersion: (tenantId, storeId, prefix) => input.store.guardVersion(tenantId, bindingGuardKey(storeId, prefix)),
    // Round 26 · OB-97: one act per approval (its key names the approval), under the (store, prefix) guard read before the
    // binding was judged — a second act racing on the same prefix is refused by name (ConcurrencyConflictError), never lost.
    recordReplacement: async (tenantId, m, expectedVersion) => {
      const key = `store-computer-replaced-${tenantId}-${m.approvalId}`;
      const [res] = await input.store.appendBatch(tenantId, [{
        stream: BOX_REPLACEMENT_STREAM,
        event: makeEvent({ id: keyedEventId('store-computer-replaced', key), type: 'StoreComputerReplaced', occurredAt: m.at, idempotencyKey: key, source: 'api/platform', payload: m }),
      }], { guard: { key: bindingGuardKey(m.storeId, m.prefix), expectedVersion } });
      return res!.record.event.payload as StoreComputerReplacement;
    },
    // Round 26 · OB-98: EACH acknowledgement is its own record (who, why, when); only a re-sent request answers the first.
    acknowledgeNotChecked: async (tenantId, a, requestKey) => {
      const request = createHash('sha256').update(requestKey).digest('hex').slice(0, 32);
      const key = `box-not-checked-ack-${tenantId}-${a.storeId}-${a.prefix}-${request}`;
      const res = await input.store.append(tenantId, BOX_AT_RISK_ACK_STREAM, makeEvent({
        id: keyedEventId('box-not-checked-ack', key), type: 'BoxAtRiskNotCheckedAcknowledged', occurredAt: a.at, idempotencyKey: key, source: 'api/platform', payload: a,
      }));
      return res.record.event.payload as AtRiskAcknowledgement;
    },
    // Verifier r19 BOX-1: what head office issued (each prefix → the stores it was issued to) and banked from sales and
    // refunds — never from any box's report — to judge what a box reports before it is folded.
    issuedAndBanked: async (tenantId) => ({
      issuedPrefixes: await issuedPrefixStores(input.store, tenantId),
      banked: await bankedReceiptCounts(input.store, tenantId, input.snapshots === undefined ? undefined : { snapshots: input.snapshots }),
    }),
    records: (tenantId) => allOf<BoxHealthRecord>(input.store, tenantId, BOX_HEALTH_STREAM, 'StoreComputerHealthReported'),
    // Round 33 · OB-121: a time window of the kept reports (served by the (tenant, type, occurred_at) index on PostgreSQL).
    recordsBetween: async (tenantId, from, to) => (await input.store.readStream(tenantId, BOX_HEALTH_STREAM, { type: 'StoreComputerHealthReported', from, to }))
      .map((e) => e.event.payload as BoxHealthRecord),
    // Verifier r22 D2 · OB-88: EACH acknowledgement is its own record (who, why, when) — a person acknowledging the same count
    // again is kept beside the first, never collapsed onto it. Only a re-sent REQUEST (the same Idempotency-Key) answers the
    // first record.
    acknowledge: async (tenantId, a, requestKey) => {
      const request = createHash('sha256').update(requestKey).digest('hex').slice(0, 32);
      const key = `box-refusal-ack-${tenantId}-${a.storeId}-${a.prefix}-${a.through}-${request}`;
      const res = await input.store.append(tenantId, BOX_REFUSAL_ACK_STREAM, makeEvent({
        id: keyedEventId('box-refusal-ack', key), type: 'BoxReportRefusalAcknowledged', occurredAt: a.at, idempotencyKey: key, source: 'api/platform', payload: a,
      }));
      return res.record.event.payload as RefusalAcknowledgement;
    },
    record: async (tenantId, r) => {
      // Round 13 (verifier B5 low · hard rule #10): keyed on WHAT the box said as well as when — a retried POST of the same
      // report collapses onto the first, but a DIFFERENT report stamped with the same moment is its own record, never
      // silently dropped. (When it arrived is not part of what the box said.)
      const { receivedAt: _arrived, ...said } = r;
      void _arrived;
      const content = createHash('sha256').update(JSON.stringify(said)).digest('hex').slice(0, 16);
      const res = await input.store.append(tenantId, BOX_HEALTH_STREAM, makeEvent({
        id: keyedEventId('box-health', `box-health-${tenantId}-${r.storeId}-${r.observedAt}-${content}`), type: 'StoreComputerHealthReported', occurredAt: r.receivedAt,
        idempotencyKey: `box-health-${tenantId}-${r.storeId}-${r.observedAt}-${content}`, source: 'api/platform', payload: r,
      }));
      return res.record.event.payload as BoxHealthRecord;
    },
  };
}

/** EA-01: every sync-watermark report each store computer made (append-only; the latest per store is read). */
const SYNC_WATERMARKS_STREAM = streamName(STREAM.org, 'store-sync-watermarks');
export function syncWatermarksAdapter(input: { readonly store: EventStore }): {
  records: (tenantId: string) => Promise<readonly SyncWatermarkRecord[]>;
  record: (tenantId: string, r: SyncWatermarkRecord) => Promise<void>;
} {
  return {
    records: (tenantId) => allOf<SyncWatermarkRecord>(input.store, tenantId, SYNC_WATERMARKS_STREAM, 'StoreSyncWatermarkReported'),
    record: async (tenantId, r) => {
      await input.store.append(tenantId, SYNC_WATERMARKS_STREAM, makeEvent({
        id: keyedEventId('sync-wm', `sync-wm-${tenantId}-${r.storeId}-${r.observedAt}`), type: 'StoreSyncWatermarkReported', occurredAt: r.receivedAt,
        // One report per (store, moment the box made it): a retried POST collapses onto the first.
        idempotencyKey: `sync-wm-${tenantId}-${r.storeId}-${r.observedAt}`, source: 'api/platform', payload: r,
      }));
    },
  };
}

/**
 * FUL-10: the customer record DERIVED from the durable sale and return streams. A projector keeps a cursor on each stream
 * and, on every read, folds what has arrived since: a banked sale that names a customer becomes a purchase on their record
 * (and an order fact segmentation reads); a return against it becomes a return fact and CORRECTS that order fact (a new,
 * latest fact with the net reduced — the purchase is never deleted). Every write is keyed on the sale or the return, so a
 * re-run, a resent sale or two readers at once change nothing twice. Merges, household links and profile views are their
 * own append-only facts.
 */
export function customer360Adapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly memberKey?: Buffer;
}): Customer360Deps {
  const cursorStream = streamName(STREAM.customer, 'facts-cursor');
  const factsOf = (ref: string): string => streamName(STREAM.customer, 'facts', ref);
  const mergesStream = streamName(STREAM.customer, 'merges');
  const householdStream = streamName(STREAM.customer, 'households');
  const viewsOf = (ref: string): string => streamName(STREAM.customer, 'profile-views', ref);
  const customers = customerAdapter({ store: input.store, now: input.now });
  const members = loyaltyMembersAdapter({ store: input.store, now: input.now, rule: () => ({ pointsPer100Inr: 0, pointValuePaise: 0 }) });

  /** The order fact segmentation reads, for one sale, at its current net (sale less what came back). */
  const recordOrderFact = async (tenantId: string, f: OrderFact & { readonly derivedFrom: string; readonly marginComplete: boolean }) => {
    await input.store.append(tenantId, ORDER_FACTS_STREAM, makeEvent({
      id: `cf-order-${f.orderId}-${f.netMinor}`, type: 'CustomerOrderFactRecorded', occurredAt: f.at,
      idempotencyKey: `cf-order-${tenantId}-${f.orderId}-${f.netMinor}-${f.marginMinor}`, source: 'api/customer', payload: f,
    }));
  };

  const catchUp = async (tenantId: string): Promise<{ readonly sales: number; readonly returns: number; readonly corrections: number }> => {
    const cursor = (await latest<{ salesSeq: number; returnsSeq: number; notesSeq?: number }>(input.store, tenantId, cursorStream, 'CustomerFactsCursor')) ?? { salesSeq: 0, returnsSeq: 0 };
    const notesSeq = cursor.notesSeq ?? 0;
    const sales = (await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', sinceSeq: cursor.salesSeq })).filter((e) => e.seq > cursor.salesSeq);
    const returns = (await input.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', sinceSeq: cursor.returnsSeq })).filter((e) => e.seq > cursor.returnsSeq);
    // FUL-10: a sale CORRECTED after it was committed — the GST credit / debit note issued against it (a void is a credit
    // note for the whole bill, `order_cancelled`) — corrects the customer's facts like a return does, as its own fact.
    const notes = (await input.store.readStream(tenantId, STREAM.finance, { type: 'CreditNoteIssued', sinceSeq: notesSeq })).filter((e) => e.seq > notesSeq);
    if (sales.length === 0 && returns.length === 0 && notes.length === 0) return { sales: 0, returns: 0, corrections: 0 };
    // Weighted-average unit cost per (product, store) — the margin on a purchase, where the cost is known.
    let costs: Map<string, { unitCostMinor: number; minorPerUnit: number }> | undefined;
    const costOf = async (productId: string, locationId: string | undefined) => {
      if (costs === undefined) {
        costs = new Map();
        for (const r of await inventoryAdapter(input).valuation(tenantId, undefined)) {
          if (r.unitCostMinor !== 'not_known') costs.set(`${r.productId}@${r.locationId}`, { unitCostMinor: r.unitCostMinor, minorPerUnit: 1 });
        }
      }
      return locationId === undefined ? undefined : costs.get(`${productId}@${locationId}`);
    };
    const marginOf = async (sale: IncomingSale): Promise<{ marginMinor: number; complete: boolean }> => {
      let cost = 0; let complete = true;
      for (const l of sale.lines) {
        const c = await costOf(l.productId, sale.locationId);
        if (c === undefined) { complete = false; continue; }
        cost += Math.round((l.quantityMinor * c.unitCostMinor) / minorPerUnitOf(l.uom));
      }
      return { marginMinor: sale.totalMinor - cost, complete };
    };
    /**
     * A sale's order fact again, at its CURRENT net: the bill less everything that came back against it and every credit note
     * counted against it, plus every debit note — a new, latest fact; the purchase is never deleted (hard rule #2).
     */
    const recorrect = async (tenantId: string, ref: string, sale: IncomingSale): Promise<void> => {
      const back = (await allOf<CustomerReturn>(input.store, tenantId, factsOf(ref), 'CustomerReturnFact')).filter((x) => x.saleId === sale.saleId)
        .reduce((s, x) => s + x.refundMinor, 0);
      const notes = (await allOf<CustomerCorrection>(input.store, tenantId, factsOf(ref), 'CustomerCorrectionFact')).filter((x) => x.saleId === sale.saleId && x.counted);
      const credited = notes.filter((x) => x.kind === 'credit_note').reduce((s, x) => s + x.grossMinor, 0);
      const debited = notes.filter((x) => x.kind === 'debit_note').reduce((s, x) => s + x.grossMinor, 0);
      const m = await marginOf(sale);
      const off = back + credited - debited;
      await recordOrderFact(tenantId, {
        orderId: sale.saleId, customerRef: ref, at: sale.committedAt, netMinor: Math.max(0, sale.totalMinor - off), marginMinor: m.marginMinor - off,
        channel: 'store', derivedFrom: notes.length > 0 ? 'sale_less_returns_and_corrections' : 'sale_less_returns', marginComplete: m.complete,
      });
    };
    let lastSales = cursor.salesSeq;
    for (const e of sales) {
      lastSales = Math.max(lastSales, e.seq);
      const sale = payloadOf<IncomingSale>(e);
      const ref = typeof sale.customerRef === 'string' && sale.customerRef.trim() !== '' ? sale.customerRef : undefined;
      if (ref === undefined) continue;
      const p: CustomerPurchase = {
        saleId: sale.saleId, customerRef: ref, receiptNumber: sale.receiptNumber, at: sale.committedAt, tradingDay: sale.tradingDay,
        laneId: sale.laneId, ...(sale.locationId === undefined ? {} : { locationId: sale.locationId }), grossMinor: sale.totalMinor, lineCount: sale.lines.length,
      };
      await input.store.append(tenantId, factsOf(ref), makeEvent({
        id: `cf-sale-${sale.saleId}`, type: 'CustomerPurchaseFact', occurredAt: sale.committedAt, idempotencyKey: `cf-sale-${tenantId}-${sale.saleId}`, source: 'api/customer', payload: p,
      }));
      const m = await marginOf(sale);
      await recordOrderFact(tenantId, { orderId: sale.saleId, customerRef: ref, at: sale.committedAt, netMinor: sale.totalMinor, marginMinor: m.marginMinor, channel: 'store', derivedFrom: 'sale', marginComplete: m.complete });
    }
    let lastReturns = cursor.returnsSeq;
    for (const e of returns) {
      lastReturns = Math.max(lastReturns, e.seq);
      const r = payloadOf<{ returnId: string; originalSaleId: string | null; processedAt: string; refundMinor: number; customerRef?: string; exchange?: unknown }>(e);
      const held = r.originalSaleId === null ? undefined : await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${r.originalSaleId}`);
      const sale = held === undefined ? undefined : held.event.payload as IncomingSale;
      const ref = typeof sale?.customerRef === 'string' && sale.customerRef.trim() !== '' ? sale.customerRef : r.customerRef;
      if (ref === undefined || ref.trim() === '') continue;
      const ret: CustomerReturn = { returnId: r.returnId, customerRef: ref, saleId: r.originalSaleId, at: r.processedAt, refundMinor: r.refundMinor, exchange: r.exchange !== undefined };
      await input.store.append(tenantId, factsOf(ref), makeEvent({
        id: `cf-ret-${r.returnId}`, type: 'CustomerReturnFact', occurredAt: r.processedAt, idempotencyKey: `cf-ret-${tenantId}-${r.returnId}`, source: 'api/customer', payload: ret,
      }));
      // The correction: the sale's order fact again, net of everything that has come back against it.
      if (sale !== undefined) await recorrect(tenantId, ref, sale);
    }
    let lastNotes = notesSeq;
    for (const e of notes) {
      lastNotes = Math.max(lastNotes, e.seq);
      const n = payloadOf<{ noteId: string; kind: 'credit_note' | 'debit_note'; againstInvoiceId: string; againstInvoiceNumber: string; reason: string; grossMinor: number; issuedOn: string }>(e);
      // The sale the note is against: by its id, or by the receipt number the bill was printed under.
      let held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${n.againstInvoiceId}`);
      if (held === undefined && typeof n.againstInvoiceNumber === 'string' && n.againstInvoiceNumber !== '') {
        const idx = await input.store.findByIdempotencyKey(tenantId, `receipt-${tenantId}-${n.againstInvoiceNumber}`);
        const saleId = (idx?.event.payload as { saleId?: string } | undefined)?.saleId;
        if (saleId !== undefined) held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`);
      }
      const sale = held?.event.payload as IncomingSale | undefined;
      const ref = typeof sale?.customerRef === 'string' && sale.customerRef.trim() !== '' ? sale.customerRef : undefined;
      if (sale === undefined || ref === undefined) continue; // a note against no banked customer sale names nobody
      const returned = (await allOf<CustomerReturn>(input.store, tenantId, factsOf(ref), 'CustomerReturnFact')).some((x) => x.saleId === sale.saleId);
      const c: CustomerCorrection = {
        noteId: n.noteId, customerRef: ref, saleId: sale.saleId, kind: n.kind, reason: n.reason, grossMinor: n.grossMinor, at: n.issuedOn,
        // A goods-returned credit note on a bill whose return is already recorded is that return's tax document — not twice.
        counted: !(n.kind === 'credit_note' && n.reason === 'goods_returned' && returned),
      };
      await input.store.append(tenantId, factsOf(ref), makeEvent({
        id: `cf-note-${n.noteId}`, type: 'CustomerCorrectionFact', occurredAt: e.event.occurredAt, idempotencyKey: `cf-note-${tenantId}-${n.noteId}`, source: 'api/customer', payload: c,
      }));
      await recorrect(tenantId, ref, sale);
    }
    await input.store.append(tenantId, cursorStream, makeEvent({
      id: `cf-cursor-${lastSales}-${lastReturns}-${lastNotes}`, type: 'CustomerFactsCursor', occurredAt: input.now(),
      idempotencyKey: `cf-cursor-${tenantId}-${lastSales}-${lastReturns}-${lastNotes}`, source: 'api/customer', payload: { salesSeq: lastSales, returnsSeq: lastReturns, notesSeq: lastNotes },
    }));
    return { sales: sales.length, returns: returns.length, corrections: notes.length };
  };

  return {
    now: input.now,
    catchUp,
    purchasesOf: (tenantId, ref) => allOf<CustomerPurchase>(input.store, tenantId, factsOf(ref), 'CustomerPurchaseFact'),
    returnsOf: (tenantId, ref) => allOf<CustomerReturn>(input.store, tenantId, factsOf(ref), 'CustomerReturnFact'),
    correctionsOf: (tenantId, ref) => allOf<CustomerCorrection>(input.store, tenantId, factsOf(ref), 'CustomerCorrectionFact'),
    merges: (tenantId) => allOf<CustomerMerge>(input.store, tenantId, mergesStream, 'CustomerMergeRecorded'),
    recordMerge: async (tenantId, m) => {
      const stage = m.reversedBy !== undefined ? 'reversed' : m.approvedBy !== undefined ? 'approved' : 'proposed';
      await input.store.append(tenantId, mergesStream, makeEvent({
        id: `cust-merge-${m.mergeId}-${stage}`, type: 'CustomerMergeRecorded', occurredAt: m.reversedAt ?? m.approvedAt ?? m.proposedAt,
        idempotencyKey: `cust-merge-${tenantId}-${m.mergeId}-${stage}`, source: 'api/customer', payload: m,
      }));
    },
    households: (tenantId) => allOf<HouseholdLink>(input.store, tenantId, householdStream, 'CustomerHouseholdLinked'),
    recordHousehold: async (tenantId, h) => {
      await input.store.append(tenantId, householdStream, makeEvent({
        id: keyedEventId('cust-hh', `cust-hh-${tenantId}-${h.customerRef}-${h.householdId}-${h.linked}-${h.at}`), type: 'CustomerHouseholdLinked', occurredAt: h.at,
        idempotencyKey: `cust-hh-${tenantId}-${h.customerRef}-${h.householdId}-${h.linked}-${h.at}`, source: 'api/customer', payload: h,
      }));
    },
    loyaltyOf: async (tenantId, ref) => {
      const balance = await customers.pointsBalance(tenantId, ref);
      const history = await members.memberHistory(tenantId, ref);
      const last = history[history.length - 1];
      return { ...(balance === undefined ? {} : { pointsBalance: balance }), ...(last === undefined ? {} : { member: { status: last.status, mobileLast4: last.mobileLast4 } }) };
    },
    recordView: async (tenantId, v) => {
      await input.store.append(tenantId, viewsOf(v.customerRef), makeEvent({
        id: keyedEventId('cust-view', `cust-view-${tenantId}-${v.customerRef}-${v.viewedBy}-${v.at}`), type: 'CustomerProfileViewed', occurredAt: v.at,
        idempotencyKey: `cust-view-${tenantId}-${v.customerRef}-${v.viewedBy}-${v.at}`, source: 'api/customer', payload: v,
      }));
    },
    views: (tenantId, ref) => allOf<ProfileView>(input.store, tenantId, viewsOf(ref), 'CustomerProfileViewed'),
  };
}

/** The alerts still in play — a cleared one (PA-12) is history, not an incident to advise on. */
function liveNotCleared<T extends { readonly state: string }>(alerts: readonly T[]): readonly (T & { readonly state: 'open' | 'acknowledged' | 'escalated' })[] {
  return alerts.filter((a): a is T & { readonly state: 'open' | 'acknowledged' | 'escalated' } => a.state !== 'cleared');
}

// GT-05 (MG-07): the migrated HISTORY register and its document files. One append-only fact per document, keyed on its kind
// and the OLD system's id (a re-run lands on the same key and the standing fact is returned); one fact per file, its bytes on
// the file's own stream (ADR 0010) and its metadata on the index, written together. Nothing here touches a trading stream.
const LEGACY_HISTORY_STREAM = streamName(STREAM.migration, 'legacy-history');
const LEGACY_ATTACHMENTS_STREAM = streamName(STREAM.migration, 'legacy-attachments');
const legacyAttachmentStream = (legacyId: string): string => streamName(STREAM.migration, 'legacy-attachment', legacyId);

export function legacyHistoryAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly targetKind: TargetKind }): LegacyHistoryDeps {
  return {
    now: input.now,
    target: (tenantId) => ({ targetId: `tgt-${tenantId}`, tenantId, kind: input.targetKind, label: input.targetKind }),
    documents: (tenantId) => allOf<LegacyHistoryDocument>(input.store, tenantId, LEGACY_HISTORY_STREAM, 'LegacyHistoryRecorded'),
    recordDocument: async (tenantId, doc) => {
      const r = await input.store.append(tenantId, LEGACY_HISTORY_STREAM, makeEvent({
        id: `legacy-history-${doc.kind}-${doc.legacyId}-${randomUUID()}`, type: 'LegacyHistoryRecorded', occurredAt: doc.recordedAt,
        idempotencyKey: `legacy-history-${tenantId}-${doc.kind}-${doc.legacyId}`, source: 'api/migration', payload: doc,
      }));
      return { standing: r.record.event.payload as LegacyHistoryDocument, existed: r.deduped };
    },
    attachments: (tenantId) => allOf<LegacyAttachmentMeta>(input.store, tenantId, LEGACY_ATTACHMENTS_STREAM, 'LegacyAttachmentIndexed'),
    attachment: async (tenantId, legacyId) => (await allOf<LegacyAttachment>(input.store, tenantId, legacyAttachmentStream(legacyId), 'LegacyAttachmentStored'))[0],
    recordAttachment: async (tenantId, a) => {
      const [stored] = await input.store.appendBatch(tenantId, [
        { stream: legacyAttachmentStream(a.legacyId), event: makeEvent({
          id: `legacy-attachment-${a.legacyId}-${randomUUID()}`, type: 'LegacyAttachmentStored', occurredAt: a.recordedAt,
          idempotencyKey: `legacy-attachment-${tenantId}-${a.legacyId}`, source: 'api/migration', payload: a,
        }) },
        { stream: LEGACY_ATTACHMENTS_STREAM, event: makeEvent({
          id: `legacy-attachment-index-${a.legacyId}-${randomUUID()}`, type: 'LegacyAttachmentIndexed', occurredAt: a.recordedAt,
          idempotencyKey: `legacy-attachment-index-${tenantId}-${a.legacyId}`, source: 'api/migration', payload: legacyAttachmentMeta(a),
        }) },
      ]);
      return { standing: legacyAttachmentMeta(stored!.record.event.payload as LegacyAttachment), existed: stored!.deduped };
    },
  };
}

/**
 * OB-39 "B" — head office's AVERAGE BUYING COST per product and store (owner, 11 Oct 2026): the quantity-weighted average of
 * what the store's receipts cost — every `received` movement that carried a cost, at any place the store holds (its floor,
 * its back store: under it in the hierarchy, or the back store its settings name). Per WHOLE unit (OB-31: per kg for a
 * product counted in grams), rounded once. A product the store never received at a cost has NO average — `undefined`,
 * never a zero (a zero cost reports a 100% margin). The ONE rule the store setup (the box's Today margin) and head office's
 * profitability report both read.
 */
export interface AverageBuyingCost {
  readonly productId: string;
  readonly storeId: string;
  readonly unitCostMinor: number;
  readonly receivedMinor: number;
  readonly receivedValueMinor: number;
}
export async function averageBuyingCosts(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, opts?: {
  /** OB-56: only receipts of this month (YYYY-MM) or earlier — the average as it stood at that month's close. */
  readonly throughPeriod?: string;
}): Promise<{
  readonly costOf: (productId: string, storeId: string) => number | undefined;
  readonly rows: readonly AverageBuyingCost[];
}> {
  const nodes = await orgStructureAdapter(input).nodes(tenantId);
  const placed = branchOfLocationIn(nodes);
  const backStoreOf = new Map<string, string>();
  for (const s of await allOf<StoreSettings>(input.store, tenantId, STORE_SETTINGS_STREAM, 'StoreSettingsSet')) {
    if (typeof s.warehouseId === 'string' && s.warehouseId !== '') backStoreOf.set(s.warehouseId, s.storeId);
  }
  const branchOf = (locationId: string): string => backStoreOf.get(locationId) ?? placed(locationId);
  const acc = new Map<string, { productId: string; storeId: string; qty: number; value: number; scale: number }>();
  for (const e of await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })) {
    const m = payloadOf<Movement>(e);
    // OB-68 "A" (owner, 11 Oct 2026): goods MADE in the store come in at their production run's own cost (the ingredients
    // consumed, at this average when the run was made) — a `produced` movement carrying that cost averages like a receipt.
    // A run whose ingredients had no cost carries none and stays out: the product is "not valued" by name, never zero.
    if ((m.kind !== 'received' && m.kind !== 'produced') || m.unitCostMinor === undefined || m.quantityMinor <= 0) continue;
    if (opts?.throughPeriod !== undefined && m.occurredAt.slice(0, 7) > opts.throughPeriod) continue;
    const storeId = branchOf(m.locationId);
    const key = `${m.productId}\u001f${storeId}`;
    const a = acc.get(key) ?? { productId: m.productId, storeId, qty: 0, value: 0, scale: minorPerUnitOf(m.uom) };
    a.qty += m.quantityMinor;
    a.value += valueAtCost(m.quantityMinor, m.uom ?? 'ea', { minor: m.unitCostMinor, ...(m.unitCostPer === undefined ? {} : { per: m.unitCostPer }) }); // OB-46
    acc.set(key, a);
  }
  const rows = [...acc.values()].map((a): AverageBuyingCost => ({
    productId: a.productId, storeId: a.storeId, unitCostMinor: Math.round((a.value * a.scale) / a.qty), receivedMinor: a.qty, receivedValueMinor: a.value,
  }));
  const byKey = new Map(rows.map((r) => [`${r.productId}\u001f${r.storeId}`, r.unitCostMinor] as const));
  return { costOf: (productId, storeId) => byKey.get(`${productId}\u001f${storeId}`), rows };
}

/**
 * OB-41 "A": the B2B portal's bank-transfer notes and finance's decisions on them — each its own append-only stream. A note
 * is keyed on its id (a re-sent note collapses); a decision on the note and its outcome (one match, one rejection).
 */
export function b2bTransferNotesAdapter(input: { readonly store: EventStore; readonly now: () => string }): Pick<B2BTransferNotesDeps, 'notes' | 'recordNote' | 'decisions' | 'recordDecision' | 'now'> {
  const notes = streamName(STREAM.b2b, 'transfer-notes');
  const decisions = streamName(STREAM.b2b, 'transfer-note-decisions');
  return {
    now: input.now,
    notes: (tenantId) => allOf<B2BTransferNote>(input.store, tenantId, notes, 'B2BTransferNoteRecorded'),
    recordNote: async (tenantId, n) => {
      await input.store.append(tenantId, notes, makeEvent({
        id: `b2b-tn-${n.noteId}`, type: 'B2BTransferNoteRecorded', occurredAt: n.recordedAt, idempotencyKey: `b2b-tn-${tenantId}-${n.noteId}`, source: 'api/finance', payload: n,
      }));
    },
    decisions: (tenantId) => allOf<B2BTransferDecision>(input.store, tenantId, decisions, 'B2BTransferNoteDecided'),
    recordDecision: async (tenantId, d) => {
      await input.store.append(tenantId, decisions, makeEvent({
        id: `b2b-tn-${d.noteId}-${d.outcome}`, type: 'B2BTransferNoteDecided', occurredAt: d.decidedAt,
        idempotencyKey: `b2b-tn-decided-${tenantId}-${d.noteId}-${d.outcome}`, source: 'api/finance', payload: d,
      }));
    },
  };
}

// ── FUL-12 · ADR-0025: which fields of which events are a customer's personal data, sealed under their own key ──────

/** The customer an order was placed by — read from the order's own record (a desk order has none: not customer-linked). */
const orderCustomer = async (ctx: { readonly tenantId: string; readonly store: EventStore }, orderId: unknown): Promise<string | undefined> => {
  if (typeof orderId !== 'string' || orderId === '') return undefined;
  const placed = await ctx.store.latestOfType(ctx.tenantId, forOrder(orderId), 'OrderPlaced');
  const ref = (placed?.event.payload as PlacedOrder | undefined)?.customerRef;
  return typeof ref === 'string' && ref !== '' ? ref : undefined;
};
const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** C20: the key category of the Internal Committee's register — retained with the register, never erased by a customer request. */
export const POSH_SEALED_CATEGORY = 'posh_records';
/** C20: a complaint's content is sealed under the complaint's own key (its id is opaque, made by the register). */
const poshSubject = (complaintId: unknown): string | undefined => {
  const id = nonEmpty(complaintId);
  return id === undefined ? undefined : `posh-complaint:${id}`;
};
/** The person a loss-prevention case is about — from the case as it was opened. */
const lpCaseSubject = async (ctx: { readonly tenantId: string; readonly store: EventStore }, caseId: unknown): Promise<string | undefined> => {
  const opened = (await ctx.store.readStream(ctx.tenantId, STREAM.lossPrevention, { type: 'LpCaseOpened' }))
    .find((e) => (e.event.payload as InvestigationCase).caseId === caseId);
  return nonEmpty((opened?.event.payload as InvestigationCase | undefined)?.subjectRef);
};

/**
 * The personal-data policy (ADR-0025 "Scope"). Each rule names the event type, the fields that are a person's own words or
 * contact details, whose they are, and the category their key belongs to — the unit an erasure destroys. The category is
 * the same one the erasure locates (`privacyDomainHoldingsAdapter`), so destroying a category's key is exactly what the
 * plan said: an erased category's key goes; a RETAINED category's key (consent proof, loss-prevention cases) is kept
 * until its own retention ends. Amounts, dates, ids and states are never sealed — the business record stays whole.
 */
export const PERSONAL_DATA_POLICY: PersonalDataPolicy = {
  // A complaint in the customer's own words, and what the desk wrote back.
  ServiceCaseRecorded: [{ category: 'service_cases', fields: ['summary', 'resolution'], subject: (h) => nonEmpty(h['customerRef']) }],
  // How a consent was captured ("otp to +91…") — kept as audit evidence, so its key is kept.
  ConsentRecorded: [{ category: 'consent_history', fields: ['evidence'], subject: (h) => nonEmpty(h['customerId']) }],
  // The words of a message queued to a customer (PA-08).
  NotificationQueue: [{ category: 'notification_intents', at: ['intent'], fields: ['text'], subject: (h) => nonEmpty(h['customerId']) }],
  // The loyalty member record: the last four digits of the number.
  LoyaltyMember: [{ category: 'loyalty_member', fields: ['mobileLast4', 'fullName' /* OB-329 (Lane 2 · P1) */], subject: (h) => nonEmpty(h['memberRef']) }],
  // The driver's notes at the door (both copies: the run's and the order's index) and the stop's area label.
  DeliveryAttempted: [{ category: 'delivery_records', fields: ['notes'], subject: (h, _p, ctx) => orderCustomer(ctx, h['orderId']) }],
  DeliveryAttemptIndexed: [{ category: 'delivery_records', fields: ['notes'], subject: (h, _p, ctx) => orderCustomer(ctx, h['orderId']) }],
  DispatchPlanned: [{ category: 'delivery_records', at: ['routes', '*', 'stops', '*'], fields: ['area'], subject: (h, _p, ctx) => orderCustomer(ctx, h['orderId']) }],
  // A loss-prevention case about a person: the summary, each evidence description, the closing note.
  LpCaseOpened: [
    { category: 'lp_records', fields: ['summary'], subject: (h) => nonEmpty(h['subjectRef']) },
    { category: 'lp_records', at: ['evidence', '*'], fields: ['description'], subject: (_h, p) => nonEmpty(p['subjectRef']) },
  ],
  LpEvidenceAdded: [{ category: 'lp_records', at: ['item'], fields: ['description'], subject: (_h, p, ctx) => lpCaseSubject(ctx, p['caseId']) }],
  LpCaseClosed: [{ category: 'lp_records', fields: ['outcomeNote'], subject: (h, _p, ctx) => lpCaseSubject(ctx, h['caseId']) }],
  // R2 C20 (verifier lanes34 NEW-5): an Internal Committee complaint — the summary, who complained and who it is about —
  // and a step's note, sealed under the COMPLAINT's own key in a category of their own. No customer erasure locates it
  // (its subject is a complaint, not a customer), so the key is retained with the register; the event ledger, the
  // backups and a whole-tenant export hold only ciphertext (`POSH_SEALED_CATEGORY` stays sealed on export).
  PoshComplaintReceived: [{ category: POSH_SEALED_CATEGORY, fields: ['summary', 'complainantRef', 'respondentRef'], subject: (h) => poshSubject(h['complaintId']) }],
  PoshComplaintStepRecorded: [{ category: POSH_SEALED_CATEGORY, fields: ['note'], subject: (h) => poshSubject(h['complaintId']) }],
};

/** The event store every domain writes through, with personal fields sealed under their subject's key (ADR-0025). */
export function personalDataStore(store: EventStore, keys: SubjectKeyStore): EventStore {
  return new PersonalDataSealingStore(store, keys, PERSONAL_DATA_POLICY, { sealedOnExport: [POSH_SEALED_CATEGORY] });
}

/**
 * WF-11 / M13-FR-02 (Batch 3 round 8): a person's decision on a returned unit held off the shelf. The decision, its
 * stock movements (keyed on the held unit — stock moves once) and, for a write-off, the M28 write-off record land in ONE
 * batch: all or nothing. Decisions live on their own append-only stream beside the held register.
 */
export function heldStockDecisionsAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<HeldStockDecisionDeps, 'approvals' | 'locationBranches' | 'recordAudit'> {
  const decisionsStream = streamName(STREAM.returns, 'held-stock-decisions');
  const writeOffs = writeOffAdapter(input);
  const blocks = saleBlocksAdapter(input);
  return {
    now: input.now,
    held: (tenantId) => allOf<HeldReturnedStock>(input.store, tenantId, HELD_RETURNED_STOCK, 'ReturnedStockHeld'),
    decisions: (tenantId) => allOf<HeldStockDecision>(input.store, tenantId, decisionsStream, 'HeldStockDecided'),
    guardVersion: (tenantId, heldId) => input.store.guardVersion(tenantId, `held-stock:${heldId}`),
    commit: async (tenantId, d, movements, writeOff, expectedVersion) => {
      await input.store.appendBatch(tenantId, [
        {
          stream: decisionsStream,
          event: makeEvent({ id: `held-decision-${d.decisionId}`, type: 'HeldStockDecided', occurredAt: d.decidedAt, idempotencyKey: `held-decision-${tenantId}-${d.decisionId}`, source: 'api/pos', payload: d }),
        },
        ...movements.map((m) => movementEvent(tenantId, m)),
        ...(writeOff === undefined ? [] : [writeOffCommittedEntry(tenantId, writeOff)]),
      ], { guard: { key: `held-stock:${d.heldId}`, expectedVersion } });
    },
    permissionsOf: async (tenantId, userId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
      return [...new Set(ROLE_CATALOGUE.filter((r) => roleIds.has(r.id)).flatMap((r) => r.permissions))];
    },
    batchBlocks: async (tenantId) => (await blocks.blocks(tenantId)).map((x) => ({ productId: x.productId, batchId: x.batchId, kind: x.kind, reason: x.reason })),
    unitCostAt: (tenantId, locationId, productId) => writeOffs.unitCostAt!(tenantId, locationId, productId),
    writeOffThreshold: (tenantId) => writeOffs.writeOffThreshold(tenantId),
  };
}

/**
 * WF-18 / M23 / D10-FR-03 (Batch 3 round 8): the period's books — count differences and write-offs to the ledger, the
 * accountant's account classes, and the reads the P&L and the close need. The counts and write-offs are the registers'
 * own records (B2's count reconciliations, the M28 write-off register), never re-typed.
 */
const ACCOUNT_CLASSES_STREAM = streamName(STREAM.finance, 'account-classes');

export function periodBooksAdapter(input: { readonly store: EventStore; readonly now: () => string }): PeriodBooksDeps {
  const fin = financeAdapter(input);
  const countsStream = streamName(STREAM.inventory, 'counts');
  const journals = (tenantId: string) => allOf<JournalEntry>(input.store, tenantId, STREAM.finance, 'JournalPosted');
  return {
    periodStates: fin.periodStates,
    nextOpenPeriod: fin.nextOpenPeriod,
    appendJournal: fin.appendJournal,
    now: input.now,
    postingMap: (tenantId) => latest<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined'),
    counts: async (tenantId) => {
      const byId = new Map<string, CountForBooks>();
      for (const r of await allOf<CountForBooks>(input.store, tenantId, countsStream, 'CountReconciled')) byId.set(r.countId, r);
      for (const d of await allOf<CountForBooks>(input.store, tenantId, countsStream, 'CountDecided')) byId.set(d.countId, d);
      // WF-08 (round 8): a planned count's variance cause (latest per count) travels into the journal's narrative.
      const causes = new Map<string, string>();
      for (const c of await allOf<{ countId: string; causeCode: string }>(input.store, tenantId, COUNT_PLANS_STREAM, 'CountVarianceCaused')) causes.set(c.countId, c.causeCode);
      return [...byId.values()].map((c) => (causes.has(c.countId) ? { ...c, causeCode: causes.get(c.countId) as string } : c));
    },
    writeOffs: (tenantId) => allOf<WriteOffForBooks>(input.store, tenantId, streamName(STREAM.inventory, 'write-offs'), 'WriteOffCommitted'),
    stockAdjustmentJournals: async (tenantId) => (await journals(tenantId)).filter((j): j is StockAdjustmentJournal => 'stockAdjustment' in j),
    journals,
    accountClasses: async (tenantId) => (await latest<{ classes: Record<string, AccountClass> }>(input.store, tenantId, ACCOUNT_CLASSES_STREAM, 'AccountClassesDefined'))?.classes,
    defineAccountClasses: async (tenantId, classes, by) => {
      const at = input.now();
      const d = createHash('sha256').update(JSON.stringify(classes)).digest('hex').slice(0, 16);
      await input.store.append(tenantId, ACCOUNT_CLASSES_STREAM, makeEvent({
        id: keyedEventId('account-classes', `account-classes-${tenantId}-${d}-${at}`), type: 'AccountClassesDefined', occurredAt: at,
        idempotencyKey: `account-classes-${tenantId}-${d}-${at}`, source: 'api/finance', payload: { classes, definedBy: by, at },
      }));
    },
  };
}

/**
 * OB-54: which store a location belongs to — a store's back-store warehouse (its settings) first, then the nearest
 * branch above it in the org hierarchy, else the location is its own key (fail closed: an unplaced location is no
 * store's but its own). The SAME rule the average buying cost places a receipt by.
 */
export async function storeOfLocationResolver(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string): Promise<{
  readonly storeOf: (locationId: string) => string;
  /** Every store head office knows: a branch in the org hierarchy, a store with settings, a store a store computer is granted for. */
  readonly knownStores: ReadonlySet<string>;
}> {
  const nodes = await orgStructureAdapter(input).nodes(tenantId);
  const placed = branchOfLocationIn(nodes);
  const known = new Set<string>(nodes.filter((n) => n.kind === 'branch').map((n) => n.nodeId));
  const backStoreOf = new Map<string, string>();
  for (const s of await allOf<StoreSettings>(input.store, tenantId, STORE_SETTINGS_STREAM, 'StoreSettingsSet')) {
    known.add(s.storeId);
    if (typeof s.warehouseId === 'string' && s.warehouseId !== '') backStoreOf.set(s.warehouseId, s.storeId);
  }
  for (const g of await effectiveGrants(input.store, tenantId)) {
    // Round 18 (verifier r17 C-2): a scope that is not a canonical id (a pasted invisible character, padding) never counts
    // as a store — so a bad scope can never inflate the stores OB-82's one-store rule counts. New scopes must also name a
    // REGISTERED store (store-computer-binding.ts KNOWN_STORE_FIELDS), so none can be added now.
    if (g.roleId === STORE_COMPUTER_ROLE_ID && g.branchScope !== 'all') for (const b of g.branchScope) if (!notCanonical(b)) known.add(b);
  }
  return { storeOf: (locationId) => backStoreOf.get(locationId) ?? placed(locationId), knownStores: known };
}

/**
 * Round 18 (verifier r17 C-2 c): the stores head office has REGISTERED — a branch in its organisation tree, or a store set
 * up with its settings. Never a grant's scope (that is what is being checked) and never a value a record merely names.
 */
/**
 * Verifier r18 C2-R1: the stock places head office has REGISTERED — an org node that is not closed (a branch, warehouse or
 * department), a store set up with its settings and that store's back-store warehouse, and the location of a warehouse bin
 * INSIDE one of those. Once a business has registered any place, stock moves only at one of these (the movements route refuses
 * any other with 422 `unknown_location`), and a transfer is judged against them — never against "a place that once held stock"
 * (a stray movement could create one) and never against a bin typed for an unregistered store.
 */
export async function knownStockPlace(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string): Promise<((locationId: string) => boolean) & { readonly registeredAny: boolean; readonly closed: ReadonlySet<string> }> {
  const known = new Set<string>();
  // Verifier r19 (6b): a CLOSED organisation node is not a stock place — kept apart so its leftover stock is named as such.
  const closed = new Set<string>();
  for (const n of await orgStructureAdapter(input).nodes(tenantId)) if (n.status !== 'closed') known.add(n.nodeId); else closed.add(n.nodeId);
  for (const s of await allOf<StoreSettings>(input.store, tenantId, STORE_SETTINGS_STREAM, 'StoreSettingsSet')) {
    known.add(s.storeId);
    if (typeof s.warehouseId === 'string' && s.warehouseId !== '') known.add(s.warehouseId);
  }
  // A bin is a place only inside a store or warehouse already registered — a bin typed for an unregistered store id never
  // makes that id (or the bin's own location) a place.
  for (const b of await warehouseAdapter(input).bins(tenantId)) {
    if (typeof b.storeId === 'string' && known.has(b.storeId) && typeof b.locationId === 'string' && b.locationId !== '') known.add(b.locationId);
  }
  for (const k of known) closed.delete(k);
  return Object.assign((locationId: string) => known.has(locationId), { registeredAny: known.size > 0, closed });
}

export async function registeredStores(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string): Promise<ReadonlySet<string>> {
  const known = new Set<string>((await orgStructureAdapter(input).nodes(tenantId)).filter((n) => n.kind === 'branch').map((n) => n.nodeId));
  for (const s of await allOf<StoreSettings>(input.store, tenantId, STORE_SETTINGS_STREAM, 'StoreSettingsSet')) known.add(s.storeId);
  return known;
}

/** WF-20 · M35-FR-04: operational incidents and post-mortems — every fact appended, keyed so a re-send is the same one. */
export function opsIncidentsAdapter(input: { readonly store: EventStore; readonly now: () => string }): OpsIncidentDeps {
  const stream = streamName(STREAM.platform, 'incidents');
  return {
    now: input.now,
    facts: (tenantId) => allOf<IncidentFact>(input.store, tenantId, stream, 'OpsIncidentFact'),
    record: async (tenantId, fact, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `ops-incident-${key}`, type: 'OpsIncidentFact', occurredAt: fact.at,
        idempotencyKey: `ops-incident-${tenantId}-${key}`, source: 'api/platform', payload: fact,
      }));
    },
    alerts: (tenantId) => alertLifecycleAdapter(input).alerts(tenantId),
    isKnownPerson: async (tenantId, userId) => (await effectiveGrants(input.store, tenantId)).some((g) => g.userId === userId),
  };
}

/**
 * WF-18: the books-to-register checks the close adds beside the card/UPI and bank checks — count differences and
 * write-offs (the stock registers against the stock-adjustment journals), payables (the purchase register against the
 * payables control account) and receivables (the credit-customer ledger against the receivables control account). A
 * check appears only when its register has something in it; otherwise it is said in `notChecked`, never counted as
 * agreement.
 */
async function bookChecksFor(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, period: string): Promise<{ checks: ControlTotalCheck[]; notChecked: string[]; books: NonNullable<MonthEvidence['books']> }> {
  const checks: ControlTotalCheck[] = [];
  const notChecked: string[] = [];
  // Stock adjustments.
  const pb = periodBooksAdapter(input);
  const [counts, writeOffs, adjJournals] = await Promise.all([pb.counts(tenantId), pb.writeOffs(tenantId), pb.stockAdjustmentJournals(tenantId)]);
  const stock = stockAdjustmentCheck(period, stockAdjustmentSources(counts, writeOffs), adjJournals);
  if (stock.check !== null) checks.push(stock.check);
  else notChecked.push(`Count differences and write-offs: none applied in ${period}.`);
  // OB-56: the stock ledger's closing value (average buying cost) against the inventory account in the books.
  const stockValue = await stockValueCheckFor(input, tenantId, period);
  if (stockValue.check !== null) checks.push(stockValue.check);
  else notChecked.push(stockValue.notChecked);
  // Payables.
  const ap = payablesAdapter(input);
  const [accounts, apJournals, map] = await Promise.all([ap.supplierAccounts(tenantId), ap.payablesJournals(tenantId), ap.postingMap(tenantId)]);
  const active = accounts.filter((a) => a.invoices.some((i) => i.matched) || a.debitNotes.length > 0 || a.payments.length > 0 || (a.openings ?? []).some((o) => o.signed));
  let payablesUnposted = 0;
  if (active.length > 0) {
    const rec = reconcilePayables(active, apJournals.map((j) => ({ ...j.payables, lines: j.lines })), map);
    payablesUnposted = rec.suppliers.reduce((n, s) => n + s.unposted.length, 0);
    checks.push({
      name: `Supplier payables as at the close of ${period}`,
      leftMinor: rec.registerOwedMinor, rightMinor: rec.ledgerOwedMinor,
      leftDerivation: PAYABLES_LEFT_DERIVATION,
      rightDerivation: rec.controlAccount === null ? 'finance ledger: no payables control account is named by the mapping in force' : PAYABLES_RIGHT_DERIVATION,
    });
  } else notChecked.push('Supplier payables: no matched bill, debit note, payment or signed opening balance is on the purchase register.');
  // Receivables (credit customers).
  const postables = await allOf<B2BPostable>(input.store, tenantId, B2B_POSTABLES, 'B2BPostable');
  const customers = [...new Set(postables.map((p) => p.customerId))].sort();
  let receivablesLedgerMinor = 0;
  let receivablesBooksMinor = 0;
  if (customers.length > 0) {
    for (const c of customers) {
      receivablesLedgerMinor += (await allOf<RecordedReceivable>(input.store, tenantId, forB2BCustomer(c), 'B2BReceivableMovement')).reduce((b, m) => b + m.deltaMinor, 0);
    }
    const control = map?.rules.find((r) => r.kind === 'b2b:invoice')?.legs.find((l) => l.side === 'debit' && l.component === 'total')?.account;
    const b2bJournals = (await allOf<JournalEntry | B2BJournal>(input.store, tenantId, STREAM.finance, 'JournalPosted')).filter((j): j is B2BJournal => 'b2b' in j);
    receivablesBooksMinor = control === undefined ? 0 : b2bJournals.flatMap((j) => j.lines).filter((l) => l.accountCode === control).reduce((n, l) => n + l.debitMinor - l.creditMinor, 0);
    checks.push({
      name: `Credit-customer receivables as at the close of ${period}`,
      leftMinor: receivablesLedgerMinor, rightMinor: receivablesBooksMinor,
      leftDerivation: 'the credit-customer ledger: every invoice and collection movement on each customer\'s account',
      rightDerivation: control === undefined ? 'finance ledger: no receivables control account is named by the mapping in force' : `finance ledger: debits less credits on ${control} across the posted B2B journals`,
    });
  } else notChecked.push('Credit-customer receivables: no credit customer has an invoice or a collection.');
  return {
    checks, notChecked,
    books: { stockAdjustmentsUnposted: stock.unposted, stockAdjustmentsUnvalued: stock.unvalued, payablesUnposted, receivablesLedgerMinor, receivablesBooksMinor },
  };
}

/**
 * D14 / M32: outbound webhooks. The events published to partners (§30.2) and the ledger stream each is read from; every
 * subscription change and every attempt is an appended fact. Without a store, nothing is subscribed and nothing is sent.
 */
export const PUBLISHED_TO_PARTNERS: Readonly<Record<string, string>> = { SaleCommitted: STREAM.sales, InventoryMoved: STREAM.inventory };
export function outboundWebhooksAdapter(input: {
  readonly store?: EventStore; readonly now: () => string;
  readonly transport?: OutboundTransport; readonly secrets?: ReadonlyMap<string, string>;
}): OutboundWebhookDeps {
  const stream = streamName(STREAM.platform, 'outbound-webhooks');
  const store = input.store;
  return {
    now: input.now,
    publishable: PUBLISHED_TO_PARTNERS,
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    facts: async (tenantId) => (store === undefined ? [] : allOf<OutboundFact>(store, tenantId, stream, 'OutboundWebhookFact')),
    record: async (tenantId, fact, key) => {
      if (store === undefined) return;
      await store.append(tenantId, stream, makeEvent({
        id: `outbound-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, type: 'OutboundWebhookFact',
        occurredAt: fact.change === 'subscribed' ? fact.subscription.setAt : fact.at,
        idempotencyKey: `outbound-${tenantId}-${key}`, source: 'api/platform', payload: fact,
      }));
    },
    eventsOf: async (tenantId, from, type, since) => (store === undefined ? [] : (await store.readStream(tenantId, from, { type, from: since }))
      .map((e) => ({ eventId: e.event.id, occurredAt: e.event.occurredAt, payload: e.event.payload }))),
    secretFor: (ref) => input.secrets?.get(ref.replace(/^vault:\/\//, '')),
  };
}

/** OB-54: what a store computer tried to send for another store — kept, never deleted (hard rule #6). */
export interface StoreComputerRefusal {
  readonly refusalId: string;
  readonly userId: string;
  /** The store the box's credential names (null: none). */
  readonly credentialStore: string | null;
  /** Why: `credential_names_no_store`, `credential_store_not_granted`, `record_names_another_store`, `record_names_unknown_store`. */
  readonly reason: string;
  /** The store the record named, and where in the record (record_names_another_store only). */
  readonly namedStore?: string;
  readonly field?: string;
  readonly method: string;
  readonly path: string;
  readonly at: string;
  /**
   * Round 14: who was refused — a store computer, or a PERSON relaying outside their branches (`outside_your_branch_scope`,
   * `relay_names_no_store`, `record_store_unresolved`, `store_field_not_readable`). Absent on refusals kept before round 14
   * (all store computers').
   */
  readonly by?: 'store_computer' | 'person';
}
export function storeComputerRefusalsAdapter(input: { readonly store: EventStore }): {
  record: (tenantId: string, r: StoreComputerRefusal) => Promise<void>;
  list: (tenantId: string) => Promise<readonly StoreComputerRefusal[]>;
} {
  const stream = streamName(STREAM.org, 'store-computer-refusals');
  return {
    record: async (tenantId, r) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `store-computer-refused-${r.refusalId}`, type: 'StoreComputerRecordRefused', occurredAt: r.at,
        idempotencyKey: `store-computer-refused-${tenantId}-${r.refusalId}`, source: 'api/platform', payload: r,
      }));
    },
    list: (tenantId) => allOf<StoreComputerRefusal>(input.store, tenantId, stream, 'StoreComputerRecordRefused'),
  };
}

/**
 * WF-08 (round 8) — stock-count PLANS on their own inventory stream: one `CountPlanRecorded` per step (created / opened /
 * approved / cancelled), folded latest per plan id; the variance causes a manager sets, latest per count; the plan's
 * counts are the count register's own records carrying `planId`; and the place's M08 movements for the as-of expected
 * figure and the freeze check.
 */
const COUNT_PLANS_STREAM = streamName(STREAM.inventory, 'count-plans');
export function countPlansAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<CountPlanDeps, 'recordAudit' | 'locationBranches'> {
  const counts = countsAdapter(input);
  const countsStream = streamName(STREAM.inventory, 'counts');
  const foldPlans = async (tenantId: string): Promise<readonly CountPlan[]> => {
    const byId = new Map<string, CountPlan>();
    for (const p of await allOf<{ plan: CountPlan }>(input.store, tenantId, COUNT_PLANS_STREAM, 'CountPlanRecorded')) {
      byId.delete(p.plan.planId); // re-insert so the fold's order is the order plans last changed
      byId.set(p.plan.planId, p.plan);
    }
    return [...byId.values()];
  };
  return {
    ...counts,
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    plan: async (tenantId, planId) => (await foldPlans(tenantId)).find((p) => p.planId === planId),
    plans: foldPlans,
    recordPlan: async (tenantId, plan, step) => {
      await input.store.append(tenantId, COUNT_PLANS_STREAM, makeEvent({
        id: `count-plan-${plan.planId}-${step}`, type: 'CountPlanRecorded', occurredAt: input.now(),
        // One event per plan per step: a re-sent step collapses (append-only, #2).
        idempotencyKey: `count-plan-${tenantId}-${plan.planId}-${step}`, source: 'api/inventory', payload: { step, plan },
      }));
    },
    // WF-08 (hard rule #10): approved OR cancelled — ONE terminal decision per plan, on one key; the loser collapses onto it
    // and is told what stands. The id is unique per write so a race meets on the key, never on the ledger's id constraint.
    closePlan: async (tenantId, plan, step) => {
      const res = await input.store.append(tenantId, COUNT_PLANS_STREAM, makeEvent({
        id: `count-plan-${plan.planId}-${step}-${randomUUID()}`, type: 'CountPlanRecorded', occurredAt: input.now(),
        idempotencyKey: `count-plan-${tenantId}-${plan.planId}-closed`, source: 'api/inventory', payload: { step, plan },
      }));
      return (res.record.event.payload as { plan: CountPlan }).plan;
    },
    causes: async (tenantId, planId) =>
      (await allOf<VarianceCause>(input.store, tenantId, COUNT_PLANS_STREAM, 'CountVarianceCaused')).filter((c) => c.planId === planId),
    recordCause: async (tenantId, cause) => {
      const digest = createHash('sha256').update(`${cause.causeCode}|${cause.note}|${cause.setBy}`).digest('hex').slice(0, 16);
      await input.store.append(tenantId, COUNT_PLANS_STREAM, makeEvent({
        id: `count-cause-${cause.countId}-${digest}`, type: 'CountVarianceCaused', occurredAt: cause.setAt,
        idempotencyKey: `count-cause-${tenantId}-${cause.countId}-${digest}`, source: 'api/inventory', payload: cause,
      }));
    },
    planCounts: async (tenantId, planId) => {
      const byId = new Map<string, StoredReconciliation>();
      for (const r of await allOf<StoredReconciliation>(input.store, tenantId, countsStream, 'CountReconciled')) if (r.planId === planId) byId.set(r.countId, r);
      for (const d of await allOf<StoredReconciliation>(input.store, tenantId, countsStream, 'CountDecided')) if (d.planId === planId) byId.set(d.countId, d);
      return [...byId.values()];
    },
    heldWriteOffs: async (tenantId, plan) => {
      const { held, applied } = await heldWriteOffsOf(input.store, tenantId);
      return heldWriteOffViews(plan.state, held.filter((h) => h.planId === plan.planId), applied);
    },
    applyHeldWriteOffs: (tenantId, plan, by, at) => applyHeldWriteOffsFor(input.store, tenantId, plan, by, at),
    movementsAt: async (tenantId, locationId, productIds) => {
      const wanted = new Set(productIds);
      const out: PlaceMovement[] = [];
      for (const e of await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })) {
        const m = payloadOf<Movement>(e);
        if (m.locationId !== locationId || !wanted.has(m.productId)) continue;
        out.push({ movementId: m.movementId, productId: m.productId, kind: m.kind, effectMinor: m.quantityMinor * EFFECT_ON_HAND[m.kind], occurredAt: m.occurredAt });
      }
      return out;
    },
  };
}

/** OB-66: one held damaged write-off on the count-plans stream, keyed on its held id (a re-sent receipt holds it once). */
function heldWriteOffEntry(tenantId: string, h: HeldWriteOff): { stream: string; event: DomainEvent } {
  return {
    stream: COUNT_PLANS_STREAM,
    event: makeEvent({ id: `count-held-write-off-${h.heldId}`, type: 'CountWriteOffHeld', occurredAt: h.recordedAt, idempotencyKey: `count-held-write-off-${tenantId}-${h.heldId}`, source: 'api/inventory', payload: h }),
  };
}

/** OB-66: the held write-offs of a plan and their applications (once each). */
async function heldWriteOffsOf(store: EventStore, tenantId: string): Promise<{ held: readonly HeldWriteOff[]; applied: readonly HeldWriteOffApplied[] }> {
  const seen = new Set<string>();
  const held = (await allOf<HeldWriteOff>(store, tenantId, COUNT_PLANS_STREAM, 'CountWriteOffHeld')).filter((h) => (seen.has(h.heldId) ? false : (seen.add(h.heldId), true)));
  const done = new Set<string>();
  const applied = (await allOf<HeldWriteOffApplied>(store, tenantId, COUNT_PLANS_STREAM, 'CountHeldWriteOffApplied')).filter((a) => (done.has(a.heldId) ? false : (done.add(a.heldId), true)));
  return { held, applied };
}

/**
 * OB-66: apply every held write-off of a CLOSED plan not yet applied — per held record ONE atomic batch: the damaged units in
 * at the floor, the write-off on the register (M28) with its `wasted` movement, and the applied fact. Every entry is keyed on
 * the held record, so a re-sent approval or a retry after a crash applies nothing twice.
 */
export async function applyHeldWriteOffsFor(store: EventStore, tenantId: string, plan: CountPlan, by: string, at: string): Promise<readonly HeldWriteOffApplied[]> {
  if (plan.state !== 'approved' && plan.state !== 'cancelled') return [];
  const { held, applied } = await heldWriteOffsOf(store, tenantId);
  const done = new Set(applied.map((a) => a.heldId));
  const out: HeldWriteOffApplied[] = [];
  for (const h of held.filter((x) => x.planId === plan.planId && !done.has(x.heldId))) {
    const app = heldApplication(h, plan.state, by, at);
    await store.appendBatch(tenantId, [
      ...movementEntries(tenantId, [app.inMovement, app.wasted]),
      writeOffCommittedEntry(tenantId, app.writeOff, at),
      { stream: COUNT_PLANS_STREAM, event: makeEvent({ id: `count-held-write-off-applied-${h.heldId}`, type: 'CountHeldWriteOffApplied', occurredAt: at, idempotencyKey: `count-held-write-off-applied-${tenantId}-${h.heldId}`, source: 'api/inventory', payload: app.applied }) },
    ]);
    out.push(app.applied);
  }
  return out;
}

/** OB-66: held write-offs not yet applied, recorded in the month or earlier — the month-end stock adjustment waits for them. */
export async function unappliedHeldWriteOffs(store: EventStore, tenantId: string, period: string): Promise<readonly string[]> {
  const { held, applied } = await heldWriteOffsOf(store, tenantId);
  const done = new Set(applied.map((a) => a.heldId));
  return held.filter((h) => !done.has(h.heldId) && h.recordedAt.slice(0, 7) <= period && h.valueMinor > 0)
    .map((h) => `held_write_off:${h.heldId} (held for count plan ${h.planId})`);
}

/**
 * WF-03 · D02-FR-01 (round 8) — category purchase budgets and their over-budget overrides on their own purchase stream; the
 * orders are the purchase-order fold; a product's category is the product master's department.
 */
const PURCHASE_BUDGETS_STREAM = streamName(STREAM.purchase, 'budgets');
export function openToBuyAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<OpenToBuyDeps, 'recordAudit' | 'storeOf'> {
  const master = productMasterAdapter(input);
  return {
    now: input.now,
    budgets: (tenantId) => allOf<PurchaseBudget>(input.store, tenantId, PURCHASE_BUDGETS_STREAM, 'PurchaseBudgetSet'),
    recordBudget: async (tenantId, budget) => {
      const v = (b: PurchaseBudget): string => `${budgetKey(b)}|${b.amountMinor}|${b.reason}|${b.setBy}`;
      const digest = createHash('sha256').update(v(budget)).digest('hex').slice(0, 16);
      // The same figure for the same key by the same person, while in force, collapses; a new figure — including back to an
      // earlier one — is a new record over the one it supersedes (hard rule #10, verifier r18; latest wins).
      await appendSetting(input.store, tenantId, PURCHASE_BUDGETS_STREAM, {
        type: 'PurchaseBudgetSet', idPrefix: 'purchase-budget', valueKey: `purchase-budget-${tenantId}-${digest}`,
        occurredAt: budget.setAt, source: 'api/purchase', payload: budget,
        sameSubject: (p) => budgetKey(p as PurchaseBudget) === budgetKey(budget),
        subjectKey: budgetKey(budget),
        sameValue: (p) => v(p as PurchaseBudget) === v(budget),
      });
    },
    orders: async (tenantId) => [...(await foldPurchaseOrders(input.store, tenantId)).values()],
    categoryOf: async (tenantId, productId) => (await master.product(tenantId, productId))?.primaryCategoryId ?? null,
    overrides: (tenantId) => allOf<BudgetOverride>(input.store, tenantId, PURCHASE_BUDGETS_STREAM, 'PurchaseBudgetExceeded'),
    recordOverride: async (tenantId, o) => {
      // One override per order (the order is issued once) — and one per raising amendment (OB-63), each on its OWN key.
      // An amendment's key lives in its own namespace and carries the order id length-prefixed, so it can never equal an
      // order's key (an order named "po-1-amended-a1" once shared the key of amendment a1 of po-1 and silently collapsed
      // onto it) nor another (order, amendment) pair's.
      const ref = o.amendmentId === undefined ? o.poId : `${o.poId.length}:${o.poId}:${o.amendmentId}`;
      const base = o.amendmentId === undefined ? 'purchase-budget-exceeded' : 'purchase-amendment-budget-exceeded';
      await input.store.append(tenantId, PURCHASE_BUDGETS_STREAM, makeEvent({
        id: `${base}-${ref}`, type: 'PurchaseBudgetExceeded', occurredAt: o.at,
        idempotencyKey: `${base}-${tenantId}-${ref}`, source: 'api/purchase', payload: o,
      }));
    },
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),    // WF-03 (round 10): the month's open-to-buy write guard — an approval issues only while it still holds.
    budgetVersion: (tenantId, period) => input.store.guardVersion(tenantId, openToBuyGuardKey(period)),
  };
}

/**
 * D03-FR-02 (round 8) — bills handed in as an e-invoice or a scan: one `InvoiceDocumentRecorded` per state (received, then
 * confirmed), latest per document; the supplier item-code → product mappings people confirmed; the supplier found by GSTIN;
 * and the supplier-invoice register's own capture (the portal path) as the one way onto the register.
 */
const INVOICE_DOCUMENTS_STREAM = streamName(STREAM.purchase, 'invoice-documents');
/** Every bill handed in, latest record per document, with the round-12 "typed as invoice X" links laid over the scans. */
export async function foldInvoiceDocuments(store: EventStore, tenantId: string): Promise<readonly InvoiceDocumentRecord[]> {
  const byId = new Map<string, InvoiceDocumentRecord>();
  for (const d of await allOf<InvoiceDocumentRecord>(store, tenantId, INVOICE_DOCUMENTS_STREAM, 'InvoiceDocumentRecorded')) { byId.delete(d.documentId); byId.set(d.documentId, d); }
  return withTypedLinks([...byId.values()], await allOf<ScanTypedLink>(store, tenantId, INVOICE_DOCUMENTS_STREAM, 'InvoiceDocumentTyped'));
}

/**
 * D03-FR-02 (round 12): "scan D was typed as invoice X" — one append-only event per document (fixed id and key), never a
 * rewrite of the document. Answers the link that STANDS: a re-send collapses onto it; a capture naming the same scan for
 * a different invoice gets the first link back and the route refuses it by name.
 */
/** The one record of a captured supplier invoice — keyed on the invoice id, so a re-sent capture collapses onto the first. */
export function supplierInvoiceCapturedEvent(tenantId: string, record: SupplierInvoiceRecord): DomainEvent {
  return makeEvent({
    id: `invoice-${record.invoiceId}`,
    type: 'SupplierInvoiceCaptured',
    occurredAt: record.capturedAt,
    // One invoice, one record: the key carries no timestamp, so a re-sent capture collapses onto the first.
    idempotencyKey: `invoice-${tenantId}-${record.invoiceId}`,
    source: 'api/purchase',
    payload: record,
  });
}

/**
 * D03-FR-02 · round 13 (verifier B3 · P-08): record "this scan was typed as invoice X" — and, when given, the invoice
 * itself — in ONE atomic batch, so a scan never reads "captured" for an invoice that was never saved (a crash or a refusal
 * between two writes used to orphan the link). Guarded on the scan: the standing link is read under the guard and the
 * batch lands only while the guard still holds, so two captures racing for one scan cannot both write — the loser writes
 * NOTHING (neither link nor invoice) and is answered with the link that stands. Answers the standing link.
 */
export async function recordInvoiceDocumentTyped(store: EventStore, tenantId: string, link: ScanTypedLink, invoice?: BatchEntry): Promise<ScanTypedLink> {
  const linkKey = `invoice-document-typed-${tenantId}-${link.documentId}`;
  const guardKey = `invoice-document-typed:${link.documentId}`;
  for (let attempt = 0; ; attempt += 1) {
    const version = await store.guardVersion(tenantId, guardKey);
    const standing = await store.findByIdempotencyKey(tenantId, linkKey);
    // Another invoice holds this scan: nothing is written (the invoice is not kept without its scan's link).
    if (standing !== undefined && (standing.event.payload as ScanTypedLink).invoiceId !== link.invoiceId) return standing.event.payload as ScanTypedLink;
    const entries: BatchEntry[] = [{ stream: INVOICE_DOCUMENTS_STREAM, event: makeEvent({
      id: `invoice-document-typed-${link.documentId}`, type: 'InvoiceDocumentTyped', occurredAt: link.typedAt,
      idempotencyKey: linkKey, source: 'api/purchase', payload: link,
    }) }, ...(invoice === undefined ? [] : [invoice])];
    try {
      const [res] = await store.appendBatch(tenantId, entries, { guard: { key: guardKey, expectedVersion: version } });
      return res!.record.event.payload as ScanTypedLink;
    } catch (err) {
      if (!(err instanceof ConcurrencyConflictError) || err.key !== guardKey || attempt >= 4) throw err;
    }
  }
}

export function invoiceIngestionAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<InvoiceIngestionDeps, 'recordAudit' | 'extractor'> {
  const fold = (tenantId: string): Promise<readonly InvoiceDocumentRecord[]> => foldInvoiceDocuments(input.store, tenantId);
  return {
    now: input.now,
    document: async (tenantId, documentId) => (await fold(tenantId)).find((d) => d.documentId === documentId),
    documents: fold,
    recordDocument: async (tenantId, doc) => {
      await input.store.append(tenantId, INVOICE_DOCUMENTS_STREAM, makeEvent({
        id: `invoice-document-${doc.documentId}-${doc.state}`, type: 'InvoiceDocumentRecorded', occurredAt: doc.confirmedAt ?? doc.receivedAt,
        // One record per document per state: a re-sent receipt or confirmation collapses.
        idempotencyKey: `invoice-document-${tenantId}-${doc.documentId}-${doc.state}`, source: 'api/purchase', payload: doc,
      }));
    },
    supplierByGstin: async (tenantId, gstin) =>
      [...(await foldSupplierRecords(input.store, tenantId)).values()].find((r) => r.gstin !== null && r.gstin.toUpperCase() === gstin.toUpperCase())?.supplierId,
    mappings: async (tenantId, supplierId) =>
      (await allOf<ItemMapping>(input.store, tenantId, INVOICE_DOCUMENTS_STREAM, 'SupplierItemMapped')).filter((m) => m.supplierId === supplierId),
    recordMappings: async (tenantId, mappings) => {
      for (const m of mappings) {
        await input.store.append(tenantId, INVOICE_DOCUMENTS_STREAM, makeEvent({
          id: `supplier-item-${m.supplierId}-${m.supplierItemCode}-${m.productId}`, type: 'SupplierItemMapped', occurredAt: m.at,
          idempotencyKey: `supplier-item-${tenantId}-${m.supplierId}-${m.supplierItemCode}-${m.productId}-${m.at}`, source: 'api/purchase', payload: m,
        }));
      }
    },
    purchase: purchaseAdapter(input),
  };
}

/** D05-FR-03 (round 8) — the online safety-stock buffer figures, append-only on their own inventory stream (latest wins). */
const ONLINE_BUFFER_STREAM = streamName(STREAM.inventory, 'online-buffer');
export function onlineBufferAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<OnlineBufferDeps, 'recordAudit' | 'locationBranches'> {
  const orders = ordersAdapter({ store: input.store, now: input.now, holdMinutes: 0 });
  return {
    now: input.now,
    buffers: (tenantId) => allOf<OnlineBuffer>(input.store, tenantId, ONLINE_BUFFER_STREAM, 'OnlineBufferSet'),
    recordBuffer: async (tenantId, b) => {
      const digest = createHash('sha256').update(`${b.locationId}|${b.productId ?? '*'}|${b.bufferMinor}|${b.reason}|${b.setBy}|${b.setAt}`).digest('hex').slice(0, 16);
      await input.store.append(tenantId, ONLINE_BUFFER_STREAM, makeEvent({
        id: `online-buffer-${digest}`, type: 'OnlineBufferSet', occurredAt: b.setAt,
        idempotencyKey: `online-buffer-${tenantId}-${digest}`, source: 'api/inventory', payload: b,
      }));
    },
    onHand: (tenantId, locationId) => orders.onHand(tenantId, locationId),
    promised: async (tenantId, locationId) => {
      const out = new Map<string, number>();
      for (const r of await orders.outstanding(tenantId, locationId)) out.set(r.productId, (out.get(r.productId) ?? 0) + r.quantityMinor);
      return out;
    },
  };
}

/** M30 round 8 — every published version of a product, oldest first, with the id of the event that published it. */
export async function productVersionsOf(store: EventStore, tenantId: string, productId: string): Promise<readonly { readonly eventId: string; readonly product: ProductRecord }[]> {
  return (await store.readStream(tenantId, PRODUCTS_STREAM, { type: 'ProductPublished' }))
    .map((ev) => ({ eventId: ev.event.id, product: payloadOf<ProductRecord>(ev) }))
    .filter((v) => v.product.productId === productId);
}


const OUTSIDE_LOGIN_EVENTS = new Set(['OutsideLoginInvited', 'OutsideLoginApproved', 'OutsideLoginRejected', 'OutsideLoginRevoked']);

/** Every OB-76 outside-login invite, with what became of it (folded from the identity ledger). */
async function outsideLoginRecords(store: EventStore, tenantId: string): Promise<readonly OutsideLoginRecord[]> {
  return foldOutsideLogins((await store.readStream(tenantId, STREAM.identity))
    .filter((e) => OUTSIDE_LOGIN_EVENTS.has(e.event.type))
    .map((e) => ({ ...payloadOf<Record<string, unknown>>(e), type: e.event.type } as unknown as OutsideLoginEvent)));
}

/**
 * Round 14 (verifier G4 · hard rule #10): which party an OB-76 outside login is bound to NOW — resolved from the approved
 * invite's own lifecycle, never from the latest binding row (which a re-binding to an earlier party used to collapse onto).
 * 'ungoverned': the login has no OB-76 invite of this role (bound some other way — its binding rows decide). undefined:
 * governed, and no approved, unrevoked invite stands (revoked, rejected, pending) — it reads nobody's rows. Two approved
 * at once (a ledger from before the per-login guard) is not guessed between: it reads nobody's rows either.
 */
export async function governedOutsideBinding(store: EventStore, tenantId: string, userId: string, role: OutsidePartyRole): Promise<OutsideLoginRecord | undefined | 'ungoverned'> {
  const mine = (await outsideLoginRecords(store, tenantId)).filter((r) => r.userId === userId && r.role === role);
  if (mine.length === 0) return 'ungoverned';
  const approved = mine.filter((r) => r.state === 'approved');
  return approved.length === 1 ? approved[0] : undefined;
}

/**
 * Round 14 (verifier G5): the outside-party role this user holds NOW, or has an open (invited or approved) OB-76 invite
 * for — undefined for anyone else. Read from head office's own ledger, never the request.
 */
export async function outsideLoginOf(store: EventStore, tenantId: string, userId: string, at: string): Promise<string | undefined> {
  const held = (await rolesHeldNow(store, tenantId, userId, at)).find((r) => (OUTSIDE_PARTY_ROLES as readonly string[]).includes(r));
  if (held !== undefined) return held;
  return (await outsideLoginRecords(store, tenantId)).find((r) => r.userId === userId && (r.state === 'invited' || r.state === 'approved'))?.role;
}

/** Round 14 (verifier G6): the per-login write guard an outside-login invite and approval claim the login under. */
const outsideLoginGuard = (userId: string): string => `outside-login:${userId}`;

/**
 * OB-76 (owner, 12 Oct 2026): logins for outside parties — the invite, the second person's approval, a rejection and a
 * revocation, on the identity ledger beside the grants. An approval is ONE batch with the `RoleGranted` the access
 * resolver folds (who invited as the requester, who approved as the approver), and a revocation ONE batch with the
 * `RoleRevoked` that takes it away — so the role and its record never disagree. The party's own binding (the B2B portal's
 * login binding; the supplier portal partner's logins) is written through those portals' own adapters.
 */
export function outsidePartyLoginAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Pick<OutsidePartyLoginDeps, 'now' | 'invites' | 'recordInvite' | 'recordApproval' | 'recordRejection' | 'recordRevocation' | 'rolesHeldBy' | 'partyExists' | 'bind'> {
  const outsideEvent = (tenantId: string, type: string, id: string, at: string, payload: unknown): BatchEntry => ({
    stream: STREAM.identity,
    event: makeEvent({ id: `outside-login-${id}`, type, occurredAt: at, idempotencyKey: `outside-login-${tenantId}-${id}`, source: 'api/identity', payload }),
  });
  return {
    now: input.now,
    invites: (tenantId) => outsideLoginRecords(input.store, tenantId),
    // Round 14 (verifier G6): the invite claims the LOGIN under its per-login guard — read before the open-invite check, so
    // of two invites for one login sent at the same moment exactly one lands; the other reads 'login_taken' (a 409).
    recordInvite: async (tenantId, invite) => {
      const version = await input.store.guardVersion(tenantId, outsideLoginGuard(invite.userId));
      const open = (await outsideLoginRecords(input.store, tenantId)).some((r) => r.userId === invite.userId && r.inviteId !== invite.inviteId && (r.state === 'invited' || r.state === 'approved'));
      if (open) return 'login_taken';
      try {
        await input.store.appendBatch(tenantId, [outsideEvent(tenantId, 'OutsideLoginInvited', `${invite.inviteId}-invited`, invite.invitedAt, { invite })], { guard: { key: outsideLoginGuard(invite.userId), expectedVersion: version } });
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) return 'login_taken';
        throw err;
      }
      return undefined;
    },
    recordApproval: async (tenantId, invite, approvedBy, at) => {
      const provenance = { kind: 'outside_party_login', inviteId: invite.inviteId, partyRole: invite.role, partyId: invite.partyId, decision: 'OB-76' };
      // Round 14 (verifier G6): the approval claims the LOGIN under the same per-login guard: another invite of this login
      // already approved (or approved at this same moment) means this one binds nothing — 'login_taken', a visible 409.
      const version = await input.store.guardVersion(tenantId, outsideLoginGuard(invite.userId));
      if ((await outsideLoginRecords(input.store, tenantId)).some((r) => r.userId === invite.userId && r.inviteId !== invite.inviteId && r.state === 'approved')) return 'login_taken';
      const guard = { guard: { key: outsideLoginGuard(invite.userId), expectedVersion: version } };
      try {
      await input.store.appendBatch(tenantId, [
        outsideEvent(tenantId, 'OutsideLoginApproved', `${invite.inviteId}-approved`, at, { inviteId: invite.inviteId, approvedBy, at }),
        {
          stream: STREAM.identity,
          event: makeEvent({
            id: `grant-outside-${invite.inviteId}`, type: ROLE_GRANTED, occurredAt: at,
            idempotencyKey: `grant-${tenantId}-outside-${invite.inviteId}`, source: 'api/identity',
            // The same shape every other grant records: the assignment RBAC reads, plus who asked and who approved.
            payload: {
              userId: invite.userId, roleId: invite.role, branchScope: 'all',
              request: { grantId: `outside-${invite.inviteId}`, userId: invite.userId, roleId: invite.role, branchScope: 'all', requestedBy: invite.invitedBy, approvedBy, requestedAt: invite.invitedAt, reason: invite.reason ?? `login for ${invite.role} ${invite.partyId}` },
              provenance,
            },
          }),
        },
      ], guard);
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) return 'login_taken';
        throw err;
      }
      return undefined;
    },
    recordRejection: async (tenantId, inviteId, rejectedBy, reason, at) => {
      await input.store.appendBatch(tenantId, [outsideEvent(tenantId, 'OutsideLoginRejected', `${inviteId}-rejected`, at, { inviteId, rejectedBy, reason, at })]);
    },
    recordRevocation: async (tenantId, invite, revokedBy, reason, at) => {
      await input.store.appendBatch(tenantId, [
        outsideEvent(tenantId, 'OutsideLoginRevoked', `${invite.inviteId}-revoked`, at, { inviteId: invite.inviteId, revokedBy, reason, at }),
        {
          stream: STREAM.identity,
          event: makeEvent({
            id: `revoke-outside-${invite.inviteId}`, type: ROLE_REVOKED, occurredAt: at,
            idempotencyKey: `revoke-${tenantId}-outside-${invite.inviteId}`, source: 'api/identity',
            payload: { userId: invite.userId, roleId: invite.role, branchScope: 'all', provenance: { kind: 'outside_party_login', inviteId: invite.inviteId, revokedBy, reason } },
          }),
        },
        // Round 14 (verifier G4): the revocation ENDS the binding — an append-only unbinding where the party's own reads
        // look, keyed per invite, so the login reads nobody's rows until a new invite is approved and bound.
        ...(invite.role === 'b2b_customer' ? [{
          stream: forB2BPortalLogin(invite.userId),
          event: makeEvent({ id: `b2b-login-unbound-${invite.inviteId}`, type: 'B2BLoginUnbound', occurredAt: at, idempotencyKey: `b2b-login-unbound-${tenantId}-${invite.inviteId}`, source: 'api/identity', payload: { userId: invite.userId, customerId: invite.partyId, inviteId: invite.inviteId, unboundBy: revokedBy, at } }),
        }] : invite.role === 'supplier' ? [{
          stream: forPortalLogin(invite.userId),
          event: makeEvent({ id: `portal-login-unbound-${invite.inviteId}`, type: 'SupplierLoginUnbound', occurredAt: at, idempotencyKey: `portal-login-unbound-${tenantId}-${invite.inviteId}`, source: 'api/identity', payload: { userId: invite.userId, partnerId: invite.partyId, inviteId: invite.inviteId, unboundBy: revokedBy, at } }),
        }] : []),
      ]);
    },
    rolesHeldBy: async (tenantId, userId) => rolesHeldNow(input.store, tenantId, userId, input.now()),
    partyExists: async (tenantId, role, partyId) => {
      if (role === 'b2b_customer') return (await b2bCreditAdapter(input).account(tenantId, partyId)) !== undefined;
      if (role === 'supplier') return (await supplierPortalAdapter(input).partner(tenantId, partyId)) !== undefined;
      // A customer record is what the shop holds about them: a purchase, a return or a loyalty membership (customer 360).
      const c = customer360Adapter(input);
      await c.catchUp(tenantId);
      if ((await c.purchasesOf(tenantId, partyId)).length > 0 || (await c.returnsOf(tenantId, partyId)).length > 0) return true;
      const loyalty = await c.loyaltyOf(tenantId, partyId);
      return loyalty.member !== undefined || loyalty.pointsBalance !== undefined;
    },
    bind: async (tenantId, invite, by, at) => {
      if (invite.role === 'b2b_customer') {
        // Round 14 (verifier G4): keyed per INVITE — re-binding to a customer the login was bound to before is a fresh fact.
        await b2bPortalAdapter(input).recordLoginBinding(tenantId, { customerId: invite.partyId, userId: invite.userId, grants: (invite.grants ?? []) as B2BLoginBinding['grants'], boundBy: by, at }, invite.inviteId);
      } else if (invite.role === 'supplier') {
        const portal = supplierPortalAdapter(input);
        const config = await portal.partner(tenantId, invite.partyId);
        if (config !== undefined && !config.logins.includes(invite.userId)) {
          await portal.recordPartner(tenantId, invite.partyId, { ...config, logins: [...config.logins, invite.userId] }, at);
        }
        // Round 14 (verifier G4): the binding itself, keyed per INVITE and never skipped — even when the partner's list
        // already names this login (bound to it before), the re-binding is a fresh, latest fact.
        await input.store.append(tenantId, forPortalLogin(invite.userId), makeEvent({
          id: `portal-login-${invite.userId}-${invite.partyId}-${invite.inviteId}`, type: 'SupplierLoginBound', occurredAt: at,
          idempotencyKey: `portal-login-${tenantId}-${invite.userId}-${invite.partyId}-${invite.inviteId}`, source: 'api/identity',
          payload: { userId: invite.userId, partnerId: invite.partyId, inviteId: invite.inviteId },
        }));
      }
      // An app customer's login IS the customer record (the storefront scopes to the signed-in subject): nothing more to bind.
    },
  };
}

/**
 * OB-81 "A": each till's bill-number prefix, as head office issued it — an append-only log of issues, written under one
 * guard per tenant so two owners can never issue one prefix to two tills at the same moment (services/platform/src/
 * receipt-prefixes.ts judges; this keeps).
 */
const RECEIPT_PREFIX_STREAM = streamName(STREAM.org, 'till-receipt-prefixes');
const RECEIPT_PREFIX_GUARD = 'till-receipt-prefixes';
export function receiptPrefixAdapter(input: { readonly store: EventStore; readonly now: () => string }): Pick<ReceiptPrefixDeps, 'issues' | 'guardVersion' | 'recordIssue' | 'registeredTills'> {
  return {
    issues: (tenantId) => allOf<ReceiptPrefixIssue>(input.store, tenantId, RECEIPT_PREFIX_STREAM, 'TillReceiptPrefixIssued'),
    guardVersion: (tenantId) => input.store.guardVersion(tenantId, RECEIPT_PREFIX_GUARD),
    recordIssue: async (tenantId, issue, expectedVersion) => {
      try {
        const [r] = await input.store.appendBatch(tenantId, [{ stream: RECEIPT_PREFIX_STREAM, event: makeEvent({
          id: `till-receipt-prefix-${issue.storeId}-${issue.tillId}-v${issue.version}`, type: 'TillReceiptPrefixIssued', occurredAt: issue.setAt,
          idempotencyKey: `till-receipt-prefix-${tenantId}-${issue.storeId}-${issue.tillId}-v${issue.version}`, source: 'api/platform', payload: issue,
        }) }], { guard: { key: RECEIPT_PREFIX_GUARD, expectedVersion } });
        // Verifier r17 OB81-2: an all-deduped batch never trips the guard, so two people writing this till's SAME version at
        // once both "succeed" — only one lands. Say which one did; the route turns a different prefix into a visible 409.
        if (r !== undefined && r.deduped) return { kept: r.record.event.payload as ReceiptPrefixIssue };
        return undefined;
      } catch (e) {
        if (e instanceof ConcurrencyConflictError) throw new PrefixWriteRaced(e.message);
        throw e;
      }
    },
    registeredTills: async (tenantId) => (await deviceRegistryAdapter(input).fleet(tenantId))
      .filter((d) => d.kind === 'pos_lane' && d.status !== 'retired' && d.branchId !== '')
      .map((d) => ({ storeId: d.branchId, tillId: d.deviceId, label: d.label })),
  };
}

/** Round 33 · OB-121: every registration of a store computer's own lane prefixes (append-only). */
const LANE_PREFIX_STREAM = streamName(STREAM.org, 'store-computer-lane-prefixes');
/** Round 33 · OB-121: the reports refused at the door, one bounded line per store computer per day. */
const DOOR_REFUSED_STREAM = streamName(STREAM.org, 'store-computer-prefixes-refused-at-door');

/**
 * Round 33 · OB-121: the one fact of a lane-prefix registration (append-only; the same `key` again is the same registration) —
 * made by the route, by a named person, or by the demo seed's binding of its store computer (`db/seed/pilot/hosted.ts`).
 */
export function lanePrefixRegistrationEvent(tenantId: string, r: LanePrefixRegistration, key: string, source: string) {
  const k = `lane-prefixes-${tenantId}-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  return makeEvent({ id: keyedEventId('lane-prefixes', k), type: 'StoreComputerLanePrefixesRegistered', occurredAt: r.at, idempotencyKey: k, source, payload: r });
}
export { LANE_PREFIX_STREAM };

export async function lanePrefixRegistrationsOf(store: EventStore, tenantId: string): Promise<readonly LanePrefixRegistration[]> {
  return allOf<LanePrefixRegistration>(store, tenantId, LANE_PREFIX_STREAM, 'StoreComputerLanePrefixesRegistered');
}
const registeredOf = (registered: ReadonlyMap<string, ReadonlySet<string>>, storeId: string): { registered?: ReadonlySet<string> } => {
  const r = registered.get(storeId);
  return r === undefined ? {} : { registered: r };
};

/**
 * Round 33 · OB-121: the count of reports refused at the door — exact in this process (per tenant, store computer and UTC day),
 * and KEPT only at 1, 2, 4, 8 … reports (one small record each, at most ~20 a computer a day whatever it sends), so a restart
 * resumes from the last kept mark ("at least"). The prefixes themselves are never kept, only up to DOOR_REFUSAL_EXAMPLES_MAX
 * examples of 10 characters on a line.
 */
const DOOR_COUNTS = new WeakMap<EventStore, Map<string, DoorRefusalLine>>();
function doorCounts(store: EventStore): Map<string, DoorRefusalLine> {
  let m = DOOR_COUNTS.get(store);
  if (m === undefined) { m = new Map(); DOOR_COUNTS.set(store, m); }
  return m;
}
async function countRefusedAtDoor(store: EventStore, tenantId: string, r: { readonly computer: string; readonly storeId: string; readonly at: string; readonly prefixes: readonly string[] }): Promise<void> {
  const day = r.at.slice(0, 10);
  const k = `${tenantId}\u0000${r.computer}\u0000${r.storeId}\u0000${day}`;
  const counts = doorCounts(store);
  let line = counts.get(k);
  if (line === undefined) {
    // After a restart, resume from the last kept mark.
    line = (await refusedAtDoorLines(store, tenantId, false)).find((l) => l.computer === r.computer && l.storeId === r.storeId && l.day === day)
      ?? { computer: r.computer, storeId: r.storeId, day, count: 0, examples: [], first: r.at, last: r.at };
  }
  const examples = [...line.examples];
  for (const p of r.prefixes) if (examples.length < DOOR_REFUSAL_EXAMPLES_MAX && !examples.includes(p.slice(0, 10))) examples.push(p.slice(0, 10));
  const next: DoorRefusalLine = { ...line, count: line.count + 1, examples, last: r.at > line.last ? r.at : line.last };
  counts.set(k, next);
  // Old days fall out of the process's memory (they stay as kept marks).
  if (counts.size > 4_096) for (const key of counts.keys()) { if (!key.endsWith(day)) counts.delete(key); }
  if ((next.count & (next.count - 1)) === 0) {
    const key = `door-refused-${tenantId}-${createHash('sha256').update(`${r.computer}\u0000${r.storeId}`).digest('hex').slice(0, 24)}-${day}-${next.count}`;
    await store.append(tenantId, DOOR_REFUSED_STREAM, makeEvent({
      id: keyedEventId('door-refused', key), type: 'StoreComputerPrefixesRefusedAtDoor', occurredAt: r.at, idempotencyKey: key, source: 'api/platform', payload: next,
    }));
  }
}
async function refusedAtDoorLines(store: EventStore, tenantId: string, withMemory = true): Promise<readonly DoorRefusalLine[]> {
  const out = new Map<string, DoorRefusalLine>();
  const keep = (l: DoorRefusalLine): void => {
    const k = `${l.computer}\u0000${l.storeId}\u0000${l.day}`;
    const had = out.get(k);
    if (had === undefined || l.count > had.count) out.set(k, l);
  };
  for (const l of await allOf<DoorRefusalLine>(store, tenantId, DOOR_REFUSED_STREAM, 'StoreComputerPrefixesRefusedAtDoor')) keep(l);
  if (withMemory) {
    const mine = `${tenantId}\u0000`;
    for (const [k, l] of doorCounts(store)) if (k.startsWith(mine)) keep(l);
  }
  return [...out.values()].sort((a, b) => a.storeId.localeCompare(b.storeId) || a.computer.localeCompare(b.computer) || a.day.localeCompare(b.day));
}

/** Verifier r19 BOX-1: every prefix head office ever issued to a till (any version), with the stores it was issued to. */
export async function issuedPrefixStores(store: EventStore, tenantId: string): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const out = new Map<string, Set<string>>();
  for (const i of await allOf<ReceiptPrefixIssue>(store, tenantId, RECEIPT_PREFIX_STREAM, 'TillReceiptPrefixIssued')) {
    if (typeof i.prefix !== 'string' || typeof i.storeId !== 'string') continue;
    const set = out.get(i.prefix) ?? new Set<string>();
    set.add(i.storeId);
    out.set(i.prefix, set);
  }
  return out;
}

/**
 * Verifier r19 (sales lost by a restore · P-08) and BOX-1: each store's bill-number findings for the owner. The candidates
 * (numbers a box put on a bill, or cannot vouch for after a restore, that the box says it no longer holds to send — r20
 * LOST-1 — at least the grace period ago, above what head office banked or in its at-risk list) are checked against the
 * ledger, so a number banked out of order is never reported as lost.
 *
 * Verifier r20 (cost): a number ABOVE the prefix's banked count is unbanked by definition (banked is the highest count head
 * office holds, read through the fenced high-water) — no read at all. Only at-risk numbers at or below it are looked up,
 * in ONE indexed read per prefix (`existingIdempotencyKeys`, the ledger's unique (tenant, key) index), never one by one.
 *
 * Verifier r20 BOX-2: every kept report is re-judged at read (`judgeReportedIssued`: this store's own prefixes, at most
 * PLAUSIBLE_ISSUED_AHEAD above banked) — a report kept before r19 judged them at arrival can raise nothing implausible; a
 * report accepted at arrival always passes again (banked only grows, prefixes are never un-issued).
 */
export async function billNumberFindingsOf(
  store: EventStore, tenantId: string, records: readonly BoxHealthRecord[], at: string, unsentWarnHours?: number, claimSlack?: ClaimSlack,
): Promise<ReadonlyMap<string, readonly BillNumberFinding[]>> {
  return (await storeComputerReading(store, tenantId, records, at, {
    ...(unsentWarnHours === undefined ? {} : { unsentWarnHours }), ...(claimSlack === undefined ? {} : { claimSlack }),
  })).findings;
}

/**
 * Round 27 · OB-102 "A": the never-received fold's saved running result (`readNeverReceived`) — one per tenant, kept in the
 * snapshot store (disposable: delete it and the next read folds every report again, to the same answer).
 */
const NEVER_RECEIVED_PROJECTION = 'never-received-fold@1';
/** Round 27 · OB-100: at most this many held bills per prefix have their own time read for the "said unused" check (the newest). */
export { UNUSED_HELD_TIMED_MAX };

/**
 * Round 27: everything head office reads from its store computers' reports at once — the bill-number findings (r19…r26),
 * the numbers each store computer said it never used (OB-100), and the (store, prefix) bindings (OB-101) — from the
 * never-received fold resumed from its saved running result (OB-102).
 */
export async function storeComputerReading(
  store: EventStore, tenantId: string, records: readonly BoxHealthRecord[], at: string,
  opts: { readonly unsentWarnHours?: number; readonly claimSlack?: ClaimSlack; readonly timeZone?: string; readonly snapshots?: SnapshotStore } = {},
): Promise<{ findings: ReadonlyMap<string, readonly BillNumberFinding[]>; unused: ReadonlyMap<string, readonly UnusedNumbers[]>; bindings: readonly PrefixBinding[]; resumed: boolean }> {
  const { unsentWarnHours, claimSlack } = opts;
  const banked = await bankedReceiptCounts(store, tenantId);
  const issuedPrefixes = await issuedPrefixStores(store, tenantId);
  // Round 33 · OB-121: a store's own lane prefixes are the ones registered for its store computers.
  const registered = registeredByStore(await lanePrefixRegistrationsOf(store, tenantId));
  // Verifier r20 BOX-2: every kept report is re-judged at read; round 27 · OB-102: what judging drops is fingerprinted, so a
  // saved running result made before a report was judged differently is set aside.
  const judgedAway: JudgedAway[] = [];
  const judged = records.map((r) => {
    if (r.receiptNumbersIssued === undefined) return r;
    const accepted = judgeReportedIssued({ storeId: r.storeId, issued: r.receiptNumbersIssued, issuedPrefixes, banked, ...registeredOf(registered, r.storeId) }).accepted;
    if (accepted.length === r.receiptNumbersIssued.length) return r;
    for (const x of r.receiptNumbersIssued) if (!accepted.includes(x)) judgedAway.push({ receivedAt: r.receivedAt, storeId: r.storeId, prefix: x.prefix, through: x.through });
    return { ...r, receiptNumbersIssued: accepted };
  });
  // Verifier r22 D3 · OB-89: a report with no per-prefix list lets its whole queue stand in only up to the owner's line.
  // OB-90: the owner's claim slack (store setup) decides how far a sparse list is believed.
  // Round 26 · OB-97: a prefix's binding follows the owner-approved "store computer replaced" acts.
  const replacements = await allOf<StoreComputerReplacement>(store, tenantId, BOX_REPLACEMENT_STREAM, 'StoreComputerReplaced');
  // Round 27 · OB-102: resume from the saved running result; save a new one over the reports settled FOLD_SETTLE_MINUTES ago.
  const snapshots = opts.snapshots ?? processHighWaterSnapshots(store);
  const saved = (await snapshots.load<NeverReceivedSnapshot>(tenantId, BOX_HEALTH_STREAM, NEVER_RECEIVED_PROJECTION))?.result.state;
  const read = readNeverReceived({
    records: judged, at, banked, replacements, judgedAway, settleBefore: new Date(Date.parse(at) - FOLD_SETTLE_MINUTES * 60_000).toISOString(),
    ...(saved === undefined ? {} : { snapshot: saved }),
    ...(unsentWarnHours === undefined ? {} : { warnHours: unsentWarnHours }), ...(claimSlack === undefined ? {} : { slack: claimSlack }),
    ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
  });
  if (read.snapshot !== undefined) {
    await snapshots.save<NeverReceivedSnapshot>({
      tenantId, stream: BOX_HEALTH_STREAM, projection: NEVER_RECEIVED_PROJECTION, takenAt: read.snapshot.settledAt,
      result: { state: read.snapshot, watermarkSeq: 0, lastEventAt: read.snapshot.settledAt, eventCount: read.snapshot.settledCount },
    });
  }
  const acknowledged = await allOf<RefusalAcknowledgement>(store, tenantId, BOX_REFUSAL_ACK_STREAM, 'BoxReportRefusalAcknowledged');
  const atRiskAcknowledged = await allOf<AtRiskAcknowledgement>(store, tenantId, BOX_AT_RISK_ACK_STREAM, 'BoxAtRiskNotCheckedAcknowledged');
  const unusedAcknowledged = await allOf<UnusedReceivedAcknowledgement>(store, tenantId, BOX_UNUSED_ACK_STREAM, 'BoxUnusedReceivedAcknowledged');
  const finished = await finishStoreComputerReading(store, tenantId, at, read, banked, claimSlack, new Set(records.map((r) => r.storeId)), (storeId, unreceived, unusedReceived, unusedCapped) => billNumberFindingsFor({
    storeId, records: judged, at, unreceived, banked, acknowledged, replacements, atRiskAcknowledged, unusedAcknowledged,
    ...(unusedReceived === undefined ? {} : { unusedReceived }), ...(unusedCapped === undefined ? {} : { unusedCapped }),
    // Round 31 · OB-113: the refused-prefix cap counts the store's own day (the same time zone the saved result is made with).
    ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
  }));
  return { ...finished, bindings: read.bindings, resumed: read.resumed };
}

/** Round 28: the owner's settings a store-computer reading uses (each read per tenant). */
export interface StoreComputerReadingSettings {
  readonly unsentWarnHours?: (tenantId: string) => Promise<number> | number;
  readonly claimSlack?: (tenantId: string) => Promise<ClaimSlack> | ClaimSlack;
  readonly timeZone?: (tenantId: string) => Promise<string> | string;
}
async function readingSettings(s: StoreComputerReadingSettings, tenantId: string): Promise<{ unsentWarnHours?: number; claimSlack?: ClaimSlack; timeZone?: string }> {
  return {
    ...(s.unsentWarnHours === undefined ? {} : { unsentWarnHours: await s.unsentWarnHours(tenantId) }),
    ...(s.claimSlack === undefined ? {} : { claimSlack: await s.claimSlack(tenantId) }),
    ...(s.timeZone === undefined ? {} : { timeZone: await s.timeZone(tenantId) }),
  };
}

/**
 * Round 28 · OB-104 "A": the box history's saved running result (`readBoxHistory`) — one per tenant, in the snapshot store
 * (disposable: delete it and the next read folds every report again, to the same answer).
 */
const BOX_HISTORY_PROJECTION = 'box-health-history@1';
/** Round 28 · OB-104: the newest visibility fence each tenant's box history saw, per snapshot store (one that settles later is used then). */
const BOX_HISTORY_FENCES = new WeakMap<SnapshotStore, Map<string, { readonly seq: number; readonly token: string }>>();

/**
 * Round 29 · OB-106 "A" (owner, 14 Oct 2026, in writing, "Both before pilot"; verifier r28 NEW-2, NEW-8) — BUILDING THE
 * SAVED HISTORY (stated, so a person can check it):
 *   • a read that finds a saved result checks it first (`boxHistoryUnreadable`: every field's shape, and its seal) and that
 *     every (store, prefix) binding in it can be traced to the act or the report it came from (`bindingsTraced`); a result
 *     that fails is SET ASIDE — never thrown, never trusted;
 *   • with nothing usable saved, a store with at most BOX_HISTORY_INLINE_MAX reports is read whole there and then (a few
 *     milliseconds, in steps); a bigger one is BUILT IN THE BACKGROUND — one build per shop at a time (a second read joins
 *     the first's), folded in steps with a pause between them (`readBoxHistoryInSteps`), so requests, the readiness check
 *     and the store computers' uploads are answered in between. A read waits for it at most `waitMs`; until it is ready
 *     the health read says "being prepared — store computer checks not yet available" (P-08: visible, never silent), the
 *     routes that need it answer 503 with the same words, and the alert worker skips them with a note;
 *   • a result made while an open database transaction holds the visibility fence back cannot be saved (a report written in
 *     that transaction could still land below it) — it is kept in this process's memory meanwhile, used like a saved one,
 *     and the health read says how long saving has been held back.
 */
export const BOX_HISTORY_INLINE_MAX = 5_000;
/** Round 29 · OB-106: how long a health read waits for a build in progress before it answers "being prepared". */
export const BOX_HISTORY_BUILD_WAIT_MS = 1_000;
/**
 * Round 35 · verifier r34 NEW-4 — THE BUILD LEASE IS KEPT UNTIL THE RESULT IS SAVED (stated). A result made while an open
 * transaction holds the visibility fence back is kept in the builder's memory; before round 35 the builder then let go of the
 * lease, and another head-office process found nothing saved and built the whole history again. Now the builder KEEPS the
 * lease and tries to save every BOX_HISTORY_SAVE_RETRY_MS (moving the result's position up once a fence settles, so later
 * reads read only the reports after it); every other process says "being prepared — another head-office process is building
 * it now" until the result is saved, then uses it. The lease is let go once it is saved, set aside, or after
 * BOX_HISTORY_LEASE_KEEP_MAX_MS (a transaction open that long is said on the health read as "saving held back"; after it
 * another process may build — extra work only, the result is the same). A build whose lease session ends under it (an
 * idle-session timeout, a network cut) STOPS at its next step and says so, rather than build alongside a process that has
 * since taken the lease.
 */
export const BOX_HISTORY_SAVE_RETRY_MS = 500;
export const BOX_HISTORY_LEASE_KEEP_MAX_MS = 30 * 60_000;
/** Round 35 · NEW-4: the build lease's database session ended under the build — it stopped (nothing saved by it). */
export class BoxHistoryBuildLeaseLostError extends Error {
  override readonly name = 'BoxHistoryBuildLeaseLostError';
  constructor() { super('the build lease\'s database session ended under the build, so it stopped (nothing of it was saved); the next read starts it again unless another head-office process is building it'); }
}

/** Round 29 · OB-106: per snapshot store and tenant, the build in progress, a result held back from saving, and the last checks. */
interface BoxHistoryTenant {
  build?: {
    readonly promise: Promise<void>; readonly since: string; readonly why: string;
    /**
     * Every report, read once for the build (a small store's waiting reads fold these themselves). Round 34 · OB-124 (5):
     * undefined when ANOTHER head-office process holds the build lease (it is building; nothing was read here).
     */
    readonly events: Promise<readonly PersistedEvent[] | undefined>;
    /** The fence checked BEFORE those reports were read — the only one any fold of them may use. */
    readonly settledThrough: number | undefined;
    /** Round 34 · OB-124 (5): another head-office process holds the build lease — this one waits for its saved result. */
    elsewhere?: true;
    /** Round 35 · NEW-2: this process is building as many shops' histories as it may at once — this one waits its turn. */
    turn?: true;
    /** Round 35 · NEW-4: another process saved the result just before this one took the lease — it is used, not built. */
    savedElsewhere?: true;
  };
  /** Round 35 · NEW-4: the build lease kept after a build until its result is saved (see BOX_HISTORY_SAVE_RETRY_MS). */
  keeper?: { readonly stop: () => void; readonly done: Promise<void> };
  /** A result that could not be saved yet (the fence held back by an open transaction) — used like a saved one. */
  held?: BoxHistorySnapshot;
  /** Since when saving has been held back by an unsettled fence (this process's clock). */
  saveHeldSince?: string;
  /** The seal of the last result whose bindings were traced (traced once per result, not on every read). */
  traced?: string;
  /** The last build that failed, said on the health read until one succeeds. */
  failed?: { readonly at: string; readonly error: string };
  /** Round 31 · OB-114: since when (the reads' own time) the checks have been not ready without a break — being prepared, or no seal key. */
  notReadySince?: string;
  /** Round 35 · OB-129: that not-ready time, counted (head office running) and not (head office off). */
  notReady?: ChecksNotReady;
  /** Round 36 · NEW-7: the newest read's moment for this shop, and this process's clock then (a kept lease's fold moves on from it). */
  clock?: { readonly at: string; readonly ms: number };
  /** Round 37 · verifier r36 NEW-3: when this process last wrote a readiness note for this shop (its own clock). */
  readinessNoter?: ReadinessNoter;
}
const BOX_HISTORY_TENANTS = new WeakMap<SnapshotStore, Map<string, BoxHistoryTenant>>();

/**
 * Round 34 · OB-114 / OB-124 (3) (owner, 15 Oct 2026, in writing, "Build all five before pilot") — THE "NOT READY SINCE" HOUR
 * IS KEPT (stated). Since when the store computer checks have been not ready ("being prepared", or the saved history cannot be
 * sealed) is no longer held only in head office's memory: each CHANGE — not ready from a moment, or ready again — is one
 * append-only record (`StoreComputerChecksReadiness`) on its own stream, written only when the state changes, under a write
 * guard (compare-and-append, as the alert rules' saves): two head-office processes finding the same change at once land ONE
 * record, the other re-reads it. A health read takes the latest record (one indexed read) — so a head-office restart, or a
 * second head-office process, keeps the hour where it was and never delays the owner's alert. Nothing is overwritten
 * (hard rule #2); the records stay as the history of when the checks were not ready.
 */
const BOX_CHECKS_READINESS_STREAM = streamName(STREAM.org, 'store-computer-checks-readiness');
const BOX_CHECKS_READINESS_TYPE = 'StoreComputerChecksReadiness';
const BOX_CHECKS_READINESS_GUARD = 'store-computer-checks-readiness';
/** Round 34 · OB-124 (3): one change of the store computer checks' readiness (append-only). */
export interface StoreComputerChecksReadiness {
  readonly state: 'not_ready' | 'ready';
  /** From when (the read's own time that found the change). */
  readonly since: string;
  /** Why not ready: being prepared, or no seal key (absent when ready). */
  readonly why?: 'being_prepared' | 'no_seal_key';
  /**
   * Round 35 · OB-129 "A": the last moment head office was seen running with the checks still not ready (absent on a record
   * of round 34: its `since`), and, up to then, how long of this not-ready time head office was RUNNING (counted towards the
   * hour) and how long it was OFF (not counted, said separately).
   */
  readonly seenAt?: string;
  readonly runningMs?: number;
  readonly offMs?: number;
  /** Round 35 · OB-129: the reason changed during this not-ready time — from what, and when it was noted (the hour goes on). */
  readonly reasonChanged?: { readonly from: 'being_prepared' | 'no_seal_key'; readonly at: string };
  /**
   * Round 36 · verifier r35 NEW-3: what this note counted FROM — the note before it (its `seenAt` and totals). A later read
   * that finds this note stamped AHEAD of its own clock sets it aside and counts from here instead.
   */
  readonly basis?: { readonly seenAt: string; readonly runningMs: number; readonly offMs: number };
  /** Round 36 · NEW-3: the last note set aside because it was stamped ahead of head office's clock (its stamp; when noticed). */
  readonly clockAhead?: { readonly stamped: string; readonly noticedAt: string };
  /**
   * Round 36 · verifier r35 NEW-4: of `runningMs`, the time from a round-34 record (it kept no running notes) up to the first
   * note — counted as running, as round 34 did, never booked as "head office was off".
   */
  readonly beforeNotesMs?: number;
  /**
   * Round 37 · verifier r36 NEW-2: the last note this one can TRUST to count from if a later read finds the notes after it
   * stamped ahead — the note just before the newest gap booked as "head office was off" (a clock that jumped ahead looks
   * exactly like that when it happens), carried unchanged on every note until the next such gap. Absent: the start of the
   * not-ready time (`since`).
   */
  readonly trusted?: { readonly seenAt: string; readonly runningMs: number; readonly offMs: number };
}
/**
 * Round 35 · OB-129 "A" (owner, 15 Oct 2026, in writing, "Count only running time"; verifier r34 NEW-5) — THE HOUR COUNTS ONLY
 * THE TIME HEAD OFFICE IS RUNNING (stated).
 *
 *   • While the checks stay not ready, head office notes that it is still running and still not ready — one more append-only
 *     record at most every READINESS_SEEN_EVERY_MS (5 minutes) of reads (the alert worker reads every minute), carrying how long
 *     of the not-ready time so far head office was running and how long it was off. A health read takes the newest record.
 *   • A gap of more than HEAD_OFFICE_OFF_AFTER_MS (15 minutes) between the last time head office was seen running and now —
 *     head office switched off, crashed, or not reading at all — is NOT counted towards the hour: it is added to "head office
 *     was off", said on the health read ("head office was off for N hours, not counted"). A shorter gap (a quick restart) counts
 *     as running. So after a long outage there is no "stuck" alert at once: the hour goes on from where it stood. (Up to five
 *     minutes before an outage may be counted as off: the time since the last record.)
 *   • A change of REASON alone — no seal key, then being prepared (the key was fixed and the history is being built) — does NOT
 *     start the hour again: the question the alert answers is "how long have the store computer checks been unavailable while
 *     head office ran", and a reason that can change back and forth (a second head-office process holding the build lease
 *     makes a small store "being prepared" for a moment) must never keep resetting it so the owner is never told. The change
 *     is noted (`reasonChanged`, at the next note) and said on the health read. An alert already raised for the old reason
 *     stays open and clears by itself when the checks are ready — no second alert. Nothing is ever overwritten (hard rule #2).
 */
export const READINESS_SEEN_EVERY_MS = 5 * 60_000;
export const HEAD_OFFICE_OFF_AFTER_MS = 15 * 60_000;
/**
 * Round 36 · verifier r35 NEW-3 / NEW-4 (stated):
 *
 *   • A NOTE FROM A CLOCK AHEAD IS SET ASIDE. Every note is stamped with the read's own time (head office's own clock, never a
 *     caller's), so no note is ever stamped later than the clock of the process that wrote it. A read that finds the newest
 *     note stamped more than READINESS_CLOCK_TOLERANCE_MS (one minute) AHEAD of its own clock — a second head-office process
 *     whose clock runs ahead, or this one's clock stepped back after a jump forward — does not trust it: it counts from the
 *     note before it (`basis`, kept on every note), so the jump is booked neither as running nor as "head office was off", and
 *     it writes a new note at once with its own time (the count never freezes waiting for real time to pass the bad stamp).
 *     Said on the health read ("a note from a clock N minutes ahead was set aside"). Records stay append-only.
 *   • A ROUND-34 RECORD IS NOT BOOKED AS "OFF". A record written before round 35 has no running notes (`seenAt`): the time
 *     from it to the first note is counted as running, as round 34 counted it (`beforeNotesMs`, said on the health read) —
 *     never as "head office was off", which nobody could know.
 */
export const READINESS_CLOCK_TOLERANCE_MS = 60_000;
/**
 * Round 37 · verifier r36 NEW-2 / NEW-3 (stated):
 *
 *   • A RUN OF NOTES FROM A CLOCK AHEAD IS SET ASIDE AS A WHOLE. Round 36 went back ONE note (`basis`); when the clock had stayed
 *     ahead for several notes, that note was ahead too and its totals already held the jump booked as "off". Now a read that
 *     finds the newest note stamped ahead counts from the note it can trust (`trusted`: the note before the newest "off" gap —
 *     the gap the jump made — or the start of the not-ready time), over the real time since that note by its own clock: the
 *     running time the set-aside notes counted between them (each a few minutes apart on the same wrong clock) is counted as
 *     running, never more than the real time; what is left (the minutes the wrong stamps hid when the clock jumped and when
 *     it stepped back, and any real outage) is running when it is at most HEAD_OFFICE_OFF_AFTER_MS, else "off" — as any gap.
 *     Nothing is rewritten (append-only); a new note is made from this read's own time (no freeze). When even the trusted note
 *     is stamped ahead (a clock ahead from the very start), it falls back to round 36's rule and the page says so as before.
 *   • ONE NOTE PER PROCESS PER 5 MINUTES. A process writes a "still not ready" note at most once per READINESS_SEEN_EVERY_MS
 *     of ITS OWN clock (`ReadinessNoter`, kept in the process's memory), whatever the newest note's stamp says — so two
 *     head-office processes whose clocks disagree write at most two notes per 5 minutes between them, never one per read
 *     (round 36: up to 2 a minute). A clock that steps back lets the process note at once. A process restart forgets it.
 *   • LIMITATION, stated (OB-126 keeps ONE head-office process for the pilot): with two processes whose clocks differ by more
 *     than a minute, each reads the other's notes through its own clock — the one behind sees notes "ahead" (set aside, said
 *     on its page), the one ahead sees a gap as long as the difference (said as "head office was off" on ITS page when that is
 *     more than 15 minutes) and the count can be off by about the difference. It does not grow, but it is not exact. The cure
 *     is the same as for any clock problem: keep every head-office server on NTP; the page says when notes are set aside.
 */
export interface ReadinessNoter { at?: string }
/** Round 35 · OB-129: the checks' not-ready time as the reads see it now. */
export interface ChecksNotReady {
  readonly since: string;
  readonly runningMs: number;
  readonly offMs: number;
  readonly reasonChanged?: { readonly from: 'being_prepared' | 'no_seal_key'; readonly at: string };
  /** Round 36 · NEW-3: the last note set aside because it was stamped ahead of head office's clock. */
  readonly clockAhead?: { readonly stamped: string; readonly noticedAt: string };
  /** Round 36 · NEW-4: of `runningMs`, the time before the first running note (a round-34 record) — counted as running. */
  readonly beforeNotesMs?: number;
}
/** Round 34 · OB-124 (3): every readiness change kept, oldest first (for the tests and support). */
export async function storeComputerChecksReadinessHistory(store: EventStore, tenantId: string): Promise<readonly StoreComputerChecksReadiness[]> {
  return allOf<StoreComputerChecksReadiness>(store, tenantId, BOX_CHECKS_READINESS_STREAM, BOX_CHECKS_READINESS_TYPE);
}
/**
 * Round 34 · OB-124 (3): since when the checks have been not ready, as kept — recording the change when this read finds one.
 * Undefined: ready. A change that keeps losing the race (another process recording one each time) is answered from what was
 * last read, never thrown. Round 35 · OB-129 "A": with how long of it head office was running, and how long off (see above).
 */
export async function checksNotReadySince(store: EventStore, tenantId: string, notReady: false | 'being_prepared' | 'no_seal_key', at: string, noter?: ReadinessNoter): Promise<ChecksNotReady | undefined> {
  const atMs = Date.parse(at);
  const read = async (): Promise<StoreComputerChecksReadiness | undefined> =>
    (await store.latestOfType(tenantId, BOX_CHECKS_READINESS_STREAM, BOX_CHECKS_READINESS_TYPE))?.event.payload as StoreComputerChecksReadiness | undefined;
  // The not-ready time as it stands at this read, from the newest record of it.
  // Round 36 · NEW-3: a newest note stamped ahead of this read's clock is set aside (counted from the note before it);
  // NEW-4: a round-34 record (no running notes) counts as running up to the first note.
  type Point = NonNullable<StoreComputerChecksReadiness['trusted']>;
  const ahead = (iso: string): boolean => Date.parse(iso) > atMs + READINESS_CLOCK_TOLERANCE_MS;
  const counted = (last: StoreComputerChecksReadiness): { readonly now: ChecksNotReady; readonly gapMs: number; readonly basis: Point; readonly trusted?: Point; readonly setAside: boolean } => {
    const extras = (clockAhead: StoreComputerChecksReadiness['clockAhead'], beforeNotesMs: number) => ({
      ...(last.reasonChanged === undefined ? {} : { reasonChanged: last.reasonChanged }),
      ...(clockAhead === undefined ? {} : { clockAhead }),
      ...(beforeNotesMs === 0 ? {} : { beforeNotesMs }),
    });
    if (last.seenAt !== undefined && ahead(last.seenAt)) {
      // Round 37 · NEW-2: the newest note is stamped ahead — set aside with every note since the one it can trust.
      const clockAhead = { stamped: last.seenAt, noticedAt: at };
      const anchor: Point = last.trusted ?? last.basis ?? { seenAt: last.since, runningMs: 0, offMs: 0 };
      if (!ahead(anchor.seenAt)) {
        const elapsedMs = Math.max(0, atMs - Date.parse(anchor.seenAt));
        const ranMs = Math.min(Math.max(0, (last.runningMs ?? 0) - anchor.runningMs), elapsedMs);
        const restMs = elapsedMs - ranMs;
        const restOff = restMs > HEAD_OFFICE_OFF_AFTER_MS;
        return {
          gapMs: 0, setAside: true, basis: anchor, trusted: anchor,
          now: { since: last.since, runningMs: anchor.runningMs + ranMs + (restOff ? 0 : restMs), offMs: anchor.offMs + (restOff ? restMs : 0), ...extras(clockAhead, last.beforeNotesMs ?? 0) },
        };
      }
      // Even the trusted note is stamped ahead: count nothing for this read, go on from it (round 36's rule; said).
      const from: Point = { seenAt: at, runningMs: anchor.runningMs, offMs: anchor.offMs };
      return { gapMs: 0, setAside: true, basis: from, trusted: from, now: { since: last.since, runningMs: from.runningMs, offMs: from.offMs, ...extras(clockAhead, last.beforeNotesMs ?? 0) } };
    }
    const legacy = last.seenAt === undefined; // round 34: no running notes yet
    const from: Point = { seenAt: last.seenAt ?? last.since, runningMs: last.runningMs ?? 0, offMs: last.offMs ?? 0 };
    const fromMs = Date.parse(from.seenAt);
    const gapMs = Math.max(0, atMs - Math.min(fromMs, atMs));
    const off = !legacy && gapMs > HEAD_OFFICE_OFF_AFTER_MS;
    const beforeNotesMs = (last.beforeNotesMs ?? 0) + (legacy ? gapMs : 0);
    // Round 37 · NEW-2: a gap booked as off may be a clock jumping ahead — the note before it is the one to trust from now on.
    const trusted = off ? from : last.trusted;
    return {
      gapMs, setAside: false, basis: from, ...(trusted === undefined ? {} : { trusted }),
      now: { since: last.since, runningMs: from.runningMs + (off ? 0 : gapMs), offMs: from.offMs + (off ? gapMs : 0), ...extras(last.clockAhead, beforeNotesMs) },
    };
  };
  // Round 37 · NEW-3: this process noted at most once per READINESS_SEEN_EVERY_MS of its own clock (a step back: at once).
  const mayNote = (): boolean => noter?.at === undefined || atMs < Date.parse(noter.at) || atMs - Date.parse(noter.at) >= READINESS_SEEN_EVERY_MS;
  let last: StoreComputerChecksReadiness | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await read();
    const wasNotReady = last?.state === 'not_ready';
    let next: StoreComputerChecksReadiness;
    let answer: ChecksNotReady | undefined;
    if (notReady === false) {
      if (!wasNotReady) return undefined; // ready, and never not ready since the last record: nothing to record
      next = { state: 'ready', since: at };
      answer = undefined;
    } else if (wasNotReady) {
      // Still not ready (for this reason or another — the hour goes on): counted; noted at most every
      // READINESS_SEEN_EVERY_MS, and after every off gap. A changed reason is noted with the next note.
      const c = counted(last!);
      const changed = last!.why !== undefined && last!.why !== notReady ? { from: last!.why, at } : last!.reasonChanged;
      const now: ChecksNotReady = { ...c.now, ...(changed === undefined ? {} : { reasonChanged: changed }) };
      // Round 36 · NEW-3 / NEW-4: a note set aside, or a round-34 record, is noted at once (counting goes on from this read).
      if (c.gapMs < READINESS_SEEN_EVERY_MS && c.gapMs <= HEAD_OFFICE_OFF_AFTER_MS && !c.setAside && last!.seenAt !== undefined) return now;
      // Round 37 · NEW-3: never more than one note per process per 5 minutes of its own clock (the answer is the same).
      if (last!.seenAt !== undefined && !mayNote()) return now;
      next = {
        state: 'not_ready', since: last!.since, why: notReady, seenAt: at, runningMs: now.runningMs, offMs: now.offMs, basis: c.basis,
        ...(c.trusted === undefined ? {} : { trusted: c.trusted }),
        ...(changed === undefined ? {} : { reasonChanged: changed }),
        ...(now.clockAhead === undefined ? {} : { clockAhead: now.clockAhead }), ...(now.beforeNotesMs === undefined ? {} : { beforeNotesMs: now.beforeNotesMs }),
      };
      answer = now;
    } else {
      // Not ready from now: the first time, or after "ready".
      next = { state: 'not_ready', since: at, why: notReady, seenAt: at, runningMs: 0, offMs: 0 };
      answer = { since: at, runningMs: 0, offMs: 0 };
    }
    const version = await store.guardVersion(tenantId, BOX_CHECKS_READINESS_GUARD);
    // Re-read after the guard (a change landing between the two reads is then caught by the guard, never written over).
    const again = await read();
    if (JSON.stringify(again) !== JSON.stringify(last)) continue;
    const key = `store-computer-checks-readiness-${tenantId}-v${version + 1}`;
    try {
      const [res] = await store.appendBatch(tenantId, [{
        stream: BOX_CHECKS_READINESS_STREAM,
        event: makeEvent({ id: keyedEventId('box-checks-readiness', key), type: BOX_CHECKS_READINESS_TYPE, occurredAt: at, idempotencyKey: key, source: 'api/platform', payload: next }),
      }], { guard: { key: BOX_CHECKS_READINESS_GUARD, expectedVersion: version } });
      if (res!.deduped) continue; // another process recorded this change first: read what it kept
      if (noter !== undefined && next.state === 'not_ready') noter.at = at;
      return answer;
    } catch (e) {
      if (e instanceof ConcurrencyConflictError) continue;
      throw e;
    }
  }
  if (notReady === false) return undefined;
  return last?.state === 'not_ready' ? counted(last).now : { since: at, runningMs: 0, offMs: 0 };
}
function boxHistoryTenant(snapshots: SnapshotStore, tenantId: string): BoxHistoryTenant {
  let m = BOX_HISTORY_TENANTS.get(snapshots);
  if (m === undefined) { m = new Map(); BOX_HISTORY_TENANTS.set(snapshots, m); }
  let t = m.get(tenantId);
  if (t === undefined) { t = {}; m.set(tenantId, t); }
  return t;
}

/** Round 36 · NEW-7: a kept lease's fold moment — the newest read's moment, moved on by this process's clock since. */
export function foldMoment(c: { readonly at: string; readonly ms: number }, nowMs: number): string {
  return new Date(Date.parse(c.at) + Math.max(0, nowMs - c.ms)).toISOString();
}
/**
 * Round 36 · NEW-7: the newest read's moment for a shop, kept for the kept lease's folds — it moves FORWARD only (a read that
 * started a moment earlier and finished later never moves it back). Round 37 · verifier r36 NEW-5: except when a read's moment
 * is more than READINESS_CLOCK_TOLERANCE_MS BEHIND that moment moved on — head office's clock stepped back after running ahead —
 * when it starts again from that read: the kept lease never folds at a moment ahead of the reads (which would settle reports a
 * fresh read leaves unsettled, so the next read set the saved result aside: extra work).
 */
export function nextFoldClock(prev: { readonly at: string; readonly ms: number } | undefined, at: string, nowMs: number): { readonly at: string; readonly ms: number } {
  if (prev === undefined || Date.parse(at) >= Date.parse(prev.at)) return { at, ms: nowMs };
  return Date.parse(at) < Date.parse(foldMoment(prev, nowMs)) - READINESS_CLOCK_TOLERANCE_MS ? { at, ms: nowMs } : prev;
}

/**
 * Round 39 · verifier r37 L4: did result `a` fold MORE reports than result `b` (`ord` counts every report a result has folded,
 * so of two results for one shop the one with the higher count is the newer)?
 */
export function foldedMore(a: { readonly ord: number }, b: { readonly ord: number }): boolean {
  return a.ord > b.ord;
}

/** Round 28 · OB-104: what a windowed reading answers (the full reading's answers, and what the health read's judge needs). */
export interface StoreComputerHistoryReading {
  readonly findings: ReadonlyMap<string, readonly BillNumberFinding[]>;
  readonly unused: ReadonlyMap<string, readonly UnusedNumbers[]>;
  readonly unusedReceived: ReadonlyMap<string, readonly UnusedReceived[]>;
  /** Round 29 · NEW-6: per store, what the "said unused, but head office has the bill" check did not look at. */
  readonly unusedCapped: ReadonlyMap<string, readonly UnusedCheckCapped[]>;
  readonly bindings: readonly PrefixBinding[];
  readonly rawBindings: readonly PrefixBinding[];
  readonly view: BoxReportsView;
  readonly resumed: boolean;
  /** Why a saved result was set aside on this read (it then folded every report), if it was. */
  readonly setAside?: string;
  /** How many box-health reports this read took from the store (the window — or every one when nothing was saved). */
  readonly reportsRead: number;
  /** Round 29 · OB-106: the saved history is being built in the background — nothing above is known yet. */
  readonly preparing?: { readonly since: string; readonly why: string };
  /** Round 29 · OB-105/106: the saved history's size, and how long saving has been held back by an open transaction. */
  readonly history: BoxHistoryState;
  /** Round 34 · OB-104 / OB-124 (4): one store's bill-number facts at the read's moment (none while being prepared). */
  readonly facts?: (storeId: string) => StoreBillFacts;
}

const EMPTY_BOX_VIEW: BoxReportsView = {
  any: false, storeIds: [], latestOf: () => undefined, othersOf: () => [], latestEach: () => [],
  estimate: () => ({ known: false, why: 'not yet known', tradingMinutesCounted: 0, growingGaps: 0 }), waiting: () => [],
};

/** Hand the event loop back for a moment (between steps of a long fold). */
const breathe = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

/**
 * Round 28 · OB-104 "A" (owner, 13 Oct 2026, in writing, "Before the pilot"): the store-computer reading a health read and the
 * alert worker take — the same answers as `storeComputerReading` over every report (proved by test), from the box history's
 * saved running result and ONLY the reports at the store's positions after it (`readStream` with `sinceSeq`: an index range
 * scan on PostgreSQL, a binary search in memory). Round 29 · OB-106: when nothing usable is saved, see BUILDING THE SAVED
 * HISTORY above (a big store's history is built in the background and the reading says "being prepared" meanwhile).
 */
export async function storeComputerHistory(
  store: EventStore, tenantId: string, at: string,
  opts: {
    readonly unsentWarnHours?: number; readonly claimSlack?: ClaimSlack; readonly timeZone?: string; readonly snapshots?: SnapshotStore;
    /** How long to wait for a background build before answering "being prepared" (default BOX_HISTORY_BUILD_WAIT_MS). */
    readonly waitMs?: number;
    /** The pause between a build's steps (default: one turn of the event loop) — tests hold a build open with it. */
    readonly buildPause?: () => Promise<void>;
    /** Round 35 · NEW-4: how often a kept lease tries to save its result (default BOX_HISTORY_SAVE_RETRY_MS). */
    readonly saveRetryMs?: number;
    /** Round 35 · NEW-4 (internal): this read already went round once for a result another process had just saved. */
    readonly onceMore?: true;
    /**
     * Round 30 · OB-111: head office's key for the saved history's seal (`boxHistorySealKey`, from head office's own BOX_HISTORY_SEAL_KEY — OB-116). Absent:
     * nothing saved is trusted and nothing is saved — every read folds every report, and the health read says so.
     */
    readonly sealKey?: BoxHistorySealKey;
  } = {},
): Promise<StoreComputerHistoryReading> {
  const { unsentWarnHours, claimSlack } = opts;
  const snapshots = opts.snapshots ?? processHighWaterSnapshots(store);
  const tb = boxHistoryTenant(snapshots, tenantId);
  // Round 36 · verifier r35 NEW-7: what every fold is judged with — read for this read, and read AGAIN before each fold the
  // kept lease makes later (up to 30 minutes on), so a late report is never judged on bill counts or registered tills as they
  // were when the build began (the same answers as a fresh full reading at that moment, OB-104).
  const loadInputs = async () => {
    const banked = await bankedReceiptCounts(store, tenantId);
    const issuedPrefixes = await issuedPrefixStores(store, tenantId);
    const replacements = await allOf<StoreComputerReplacement>(store, tenantId, BOX_REPLACEMENT_STREAM, 'StoreComputerReplaced');
    const acknowledged = await allOf<RefusalAcknowledgement>(store, tenantId, BOX_REFUSAL_ACK_STREAM, 'BoxReportRefusalAcknowledged');
    const atRiskAcknowledged = await allOf<AtRiskAcknowledgement>(store, tenantId, BOX_AT_RISK_ACK_STREAM, 'BoxAtRiskNotCheckedAcknowledged');
    const unusedAcknowledged = await allOf<UnusedReceivedAcknowledgement>(store, tenantId, BOX_UNUSED_ACK_STREAM, 'BoxUnusedReceivedAcknowledged');
    // Verifier r19 BOX-1 / r20 BOX-2: every report is re-judged at read (`judgeReportedIssued`), as `storeComputerReading` does.
    // Round 33 · OB-121: a store's own lane prefixes are the ones REGISTERED for its store computers — never "looks like R-…-".
    const lanes = await lanePrefixRegistrationsOf(store, tenantId);
    const registered = registeredByStore(lanes);
    const judge: BoxHistoryJudge = {
      owns: (storeId, prefix) => {
        const stores = issuedPrefixes.get(prefix);
        return stores === undefined ? registered.get(storeId)?.has(prefix) ?? false : stores.has(storeId);
      },
      plausible: (prefix, through) => through <= (banked.get(prefix) ?? 0) + PLAUSIBLE_ISSUED_AHEAD,
    };
    return { banked, issuedPrefixes, replacements, acknowledged, atRiskAcknowledged, unusedAcknowledged, lanes, registered, judge };
  };
  type FoldInputs = Awaited<ReturnType<typeof loadInputs>>;
  const inputs = await loadInputs();
  const { banked, replacements, unusedAcknowledged } = inputs;
  // Round 36 · NEW-7: the newest read's moment for this shop, moved on by the time this process has run since — the moment of
  // a fold the kept lease makes later (never before the moment of a result a newer read held: NEW-2).
  tb.clock = nextFoldClock(tb.clock, at, Date.now());
  const later = (): string => foldMoment(tb.clock ?? { at, ms: Date.now() }, Date.now());
  // Each report as kept and as judged — judged only when it will be folded (one a saved result already folded is not).
  const entriesOf = async (events: readonly PersistedEvent[], skip?: (seq: number) => boolean, inp: FoldInputs = inputs): Promise<BoxHistoryEntry[]> => {
    const { issuedPrefixes, banked, registered } = inp;
    const out: BoxHistoryEntry[] = new Array(events.length);
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i]!;
      const raw = e.event.payload as BoxHealthRecord;
      if (raw.receiptNumbersIssued === undefined || skip?.(e.seq) === true) { out[i] = { raw, judged: raw, seq: e.seq }; continue; }
      const accepted = judgeReportedIssued({ storeId: raw.storeId, issued: raw.receiptNumbersIssued, issuedPrefixes, banked, ...registeredOf(registered, raw.storeId) }).accepted;
      out[i] = { raw, judged: accepted.length === raw.receiptNumbersIssued.length ? raw : { ...raw, receiptNumbersIssued: accepted }, seq: e.seq };
      if ((i + 1) % BOX_HISTORY_STEP === 0) await breathe();
    }
    return out;
  };
  const sealed = opts.sealKey === undefined ? {} : { sealKey: opts.sealKey };
  const common = (when: string, inp: FoldInputs = inputs) => ({
    at: when, banked: inp.banked, replacements: inp.replacements, refusalAcks: inp.acknowledged, atRiskAcks: inp.atRiskAcknowledged, judge: inp.judge, lanes: inp.lanes,
    settleBefore: new Date(Date.parse(when) - FOLD_SETTLE_MINUTES * 60_000).toISOString(),
    ...(unsentWarnHours === undefined ? {} : { warnHours: unsentWarnHours }), ...(claimSlack === undefined ? {} : { slack: claimSlack }),
    ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
  });
  // The visibility fence, checked BEFORE the reports are read: every report at or below a settled fence is in the read.
  const fenceNow = async (): Promise<number | undefined> => {
    if (store.positionFence === undefined || store.fenceSettled === undefined) return undefined;
    const fences = BOX_HISTORY_FENCES.get(snapshots) ?? new Map<string, { seq: number; token: string }>();
    BOX_HISTORY_FENCES.set(snapshots, fences);
    const pending = fences.get(tenantId);
    const fresh = await store.positionFence(tenantId, BOX_HEALTH_STREAM);
    let settled: number | undefined;
    if (await store.fenceSettled(tenantId, fresh.token)) { settled = fresh.seq; fences.delete(tenantId); }
    else if (pending !== undefined && await store.fenceSettled(tenantId, pending.token)) { settled = pending.seq; fences.set(tenantId, fresh); }
    else if (pending === undefined) fences.set(tenantId, fresh);
    // NEW-8: how long saving has been held back by an open transaction (shown on the health read past a line).
    if (settled === undefined) tb.saveHeldSince ??= new Date().toISOString(); else tb.saveHeldSince = undefined;
    return settled;
  };
  // Keep a new result: saved when its fence settled; else held in this process's memory until one does.
  const keep = async (snapshot: BoxHistorySnapshot, settled: boolean): Promise<void> => {
    tb.traced = snapshot.check; // made here from the reports, so its bindings are traced by construction
    // Round 39 · verifier r37 L4: a result held already that folded MORE reports than this one (a parallel read made it) is
    // never replaced by this older one, nor dropped when this one is saved — it stays held, and is saved next.
    if (!settled) { if (tb.held === undefined || !foldedMore(tb.held, snapshot)) tb.held = snapshot; return; }
    // Kept as its JSON text (jsonb keeps a string exactly; the seal is over the text as written).
    await snapshots.save<{ readonly format: string; readonly text: string }>({
      tenantId, stream: BOX_HEALTH_STREAM, projection: BOX_HISTORY_PROJECTION, takenAt: snapshot.never.settledAt,
      result: { state: boxHistoryToStore(snapshot), watermarkSeq: snapshot.seq, lastEventAt: snapshot.never.settledAt, eventCount: snapshot.ord },
    });
    // Round 37 (coordinator, CI on PR #785): a read that held a NEWER result while the save was under way keeps it held.
    // Round 39 · verifier r37 L4: so does one held BEFORE the save began (round 37 compared with what was held at the start,
    // so a newer result held then was still dropped). A held result is dropped only when this saved one folded at least as much.
    if (tb.held !== undefined && !foldedMore(tb.held, snapshot)) tb.held = undefined;
  };
  // A full read of every report (inline for a small store, or the background build): returns the reading.
  const fullRead = async (when: string, events: readonly PersistedEvent[] | undefined, settledThrough: number | undefined, pause?: () => Promise<void>) => {
    const all = events ?? await store.readStream(tenantId, BOX_HEALTH_STREAM, { type: 'StoreComputerHealthReported' });
    const read = await readBoxHistoryInSteps({ entries: await entriesOf(all), ...common(when), settledThrough: settledThrough ?? 0, ...sealed }, pause === undefined ? {} : { pause });
    if ('setAside' in read) throw new Error(`the box history cannot be read from nothing (${read.setAside})`);
    if (read.snapshot !== undefined) await keep(read.snapshot, settledThrough !== undefined);
    return { read, reportsRead: all.length };
  };
  // Round 35 · NEW-4: save a result held back from saving once a fence has settled — its position moved up to the fence
  // (only the reports after it are read, the ones it folded are skipped); set aside, it is dropped.
  // Round 36 · NEW-7: the fold is judged with the bill counts, registered tills and acts read NOW, at the moment now.
  const saveHeld = async (snap: BoxHistorySnapshot, settled: number): Promise<void> => {
    const fresh = await loadInputs();
    const events = await store.readStream(tenantId, BOX_HEALTH_STREAM, { type: 'StoreComputerHealthReported', sinceSeq: snap.seq });
    const folded = new Set(snap.folded);
    const read = await readBoxHistoryInSteps({ entries: await entriesOf(events, (seq) => folded.has(seq), fresh), snapshot: snap, sealChecked: snap.check, ...common(later(), fresh), ...sealed, settledThrough: settled });
    if (tb.held !== snap) return;
    if ('setAside' in read) { tb.held = undefined; return; }
    await keep(read.snapshot ?? snap, true);
  };
  // Round 35 · NEW-4: keep the build lease until the result it made is saved (or set aside, or BOX_HISTORY_LEASE_KEEP_MAX_MS).
  // Round 36 · verifier r35 NEW-2: until ANY result held for this shop is saved — a read that folds newer reports onto the
  // held result holds a NEWER one (still unsaved), and the lease is kept for that one too (before, it was let go unsaved).
  const keepLeaseUntilSaved = (lease: BuildLeaseHeld): NonNullable<BoxHistoryTenant['keeper']> => {
    let stopped = false;
    let wake: () => void = () => undefined;
    const token: { done?: Promise<void> } = {};
    const done = (async (): Promise<void> => {
      const until = Date.now() + BOX_HISTORY_LEASE_KEEP_MAX_MS;
      try {
        while (!stopped && tb.held !== undefined && !lease.lost() && Date.now() < until) {
          await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, opts.saveRetryMs ?? BOX_HISTORY_SAVE_RETRY_MS).unref?.(); });
          if (stopped || tb.held === undefined) break;
          const settled = await fenceNow();
          const current = tb.held; // the newest result held for this shop now (a read may have made a newer one meanwhile)
          if (settled !== undefined && current !== undefined) await saveHeld(current, settled);
        }
      } catch (e) {
        // Said on the health read (as a failed build) — the reads go on using the result and try to save it themselves.
        tb.failed = { at: new Date().toISOString(), error: `saving the built history failed: ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        if (tb.keeper?.done === token.done) tb.keeper = undefined;
        await lease();
      }
    })();
    token.done = done;
    return { stop: () => { stopped = true; wake(); }, done };
  };
  // Round 31 · OB-114: each answer says whether the checks are ready; not ready since the first read that found them so.
  // Round 34 · OB-124 (3): that moment is KEPT (append-only, guarded) — a restart or a second process keeps the same hour.
  const state = async (sizeBytes: number | null, notReady: false | 'being_prepared' | 'no_seal_key'): Promise<BoxHistoryState> => {
    // Round 37 · NEW-3: this process's own note-taking (at most one note per 5 minutes of its own clock).
    tb.readinessNoter ??= {};
    tb.notReady = await checksNotReadySince(store, tenantId, notReady, at, tb.readinessNoter);
    tb.notReadySince = tb.notReady?.since;
    return {
      sizeBytes, ...(opts.sealKey === undefined ? { noSealKey: true } : {}),
      saveHeld: tb.saveHeldSince === undefined ? null : { since: tb.saveHeldSince, waitingSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(tb.saveHeldSince)) / 1000)) },
      lastBuildFailed: tb.failed ?? null,
      ...(tb.notReady === undefined ? {} : {
        notReadySince: tb.notReady.since,
        // Round 35 · OB-129 "A": only the running time counts towards the hour; the off time is said separately.
        notReadyCountedMs: tb.notReady.runningMs, headOfficeOffMs: tb.notReady.offMs,
        ...(tb.notReady.reasonChanged === undefined ? {} : { notReadyReasonChanged: tb.notReady.reasonChanged }),
        // Round 36 · NEW-3 / NEW-4: a note from a clock ahead set aside, and the time before the first note (round 34) — said.
        ...(tb.notReady.clockAhead === undefined ? {} : { notReadyClockAhead: tb.notReady.clockAhead }),
        ...(tb.notReady.beforeNotesMs === undefined ? {} : { notReadyBeforeNotesMs: tb.notReady.beforeNotesMs }),
      }),
    };
  };
  const preparing = async (b: NonNullable<BoxHistoryTenant['build']>, sizeBytes: number | null): Promise<StoreComputerHistoryReading> => ({
    findings: new Map(), unused: new Map(), unusedReceived: new Map(), unusedCapped: new Map(), bindings: [], rawBindings: [], view: EMPTY_BOX_VIEW,
    resumed: false, reportsRead: 0, preparing: {
      since: b.since,
      why: b.elsewhere === true ? `${b.why} — another head-office process is building it now`
        : b.turn === true ? `${b.why} — waiting its turn: head office is building other shops' histories now (at most a few at once)` : b.why,
    }, history: await state(sizeBytes, 'being_prepared'),
  });
  const finish = async (done: BoxHistoryReading, reportsRead: number, setAside: string | undefined, sizeBytes: number | null): Promise<StoreComputerHistoryReading> => {
    const finished = await finishStoreComputerReading(store, tenantId, at, done, banked, claimSlack, done.storeIds, (storeId, unreceived, unusedReceived, unusedCapped) => billNumberFindingsFor({
      storeId, records: [], at, unreceived, banked, unusedAcknowledged, facts: done.facts(storeId),
      ...(unusedReceived === undefined ? {} : { unusedReceived }), ...(unusedCapped === undefined ? {} : { unusedCapped }),
    }));
    return {
      ...finished, bindings: done.bindings, rawBindings: done.rawBindings, view: done.view, resumed: done.resumed, reportsRead, facts: (storeId) => done.facts(storeId),
      ...(setAside === undefined ? {} : { setAside }), history: await state(done.snapshot?.sizeBytes ?? sizeBytes, opts.sealKey === undefined ? 'no_seal_key' : false),
    };
  };

  let setAside: string | undefined;
  let reportsRead = 0;
  for (let attempt = 0; attempt < 2 && tb.build === undefined; attempt += 1) {
    const settledThrough = await fenceNow();
    const stored = (await snapshots.load<unknown>(tenantId, BOX_HEALTH_STREAM, BOX_HISTORY_PROJECTION))?.result.state;
    if (tb.build !== undefined) break; // another read started a build meanwhile: join it
    // The newer of a result held back from saving and the saved one (a held one is always made after the saved one). Nothing
    // in it is used before `boxHistoryUnreadable` has checked its shape and its seal.
    const candidate = (tb.held ?? (stored === undefined ? undefined : boxHistoryFromStore(stored))) as BoxHistorySnapshot | undefined;
    let why = candidate === undefined ? 'nothing is saved yet (the first read, or the saved history was removed)' : undefined;
    if (candidate !== undefined) {
      const unreadable = boxHistoryUnreadable(candidate, opts.sealKey);
      why = unreadable === undefined ? undefined : `unreadable: ${unreadable}`;
      if (why === undefined && tb.traced !== candidate.check) {
        // Round 35: the reports read to trace them are counted in this read's reportsRead too (it says every report it read).
        why = await bindingsTraced(store, tenantId, candidate, replacements, (n) => { reportsRead += n; });
        if (why === undefined) tb.traced = candidate.check;
      }
    }
    if (candidate !== undefined && why === undefined) {
      // The window: only the reports above the saved result's position.
      const events = await store.readStream(tenantId, BOX_HEALTH_STREAM, { type: 'StoreComputerHealthReported', sinceSeq: candidate.seq });
      reportsRead += events.length;
      const folded = new Set(candidate.folded);
      const read = await readBoxHistoryInSteps({
        entries: await entriesOf(events, (seq) => folded.has(seq)), snapshot: candidate, sealChecked: candidate.check, ...common(at), ...sealed,
        // Never below the result's own position (a fence that has not settled gives no new one).
        ...(settledThrough === undefined ? (tb.held === candidate ? { settledThrough: candidate.seq } : {}) : { settledThrough }),
      });
      if (!('setAside' in read)) {
        if (read.snapshot !== undefined) await keep(read.snapshot, settledThrough !== undefined);
        // A result held back from saving is saved as it is once a fence has settled (its position and the reports it folded
        // above it were safe when it was made) — not only when enough new reports come to make a newer one.
        else if (tb.held === candidate && settledThrough !== undefined) await keep(candidate, true);
        return finish(read, reportsRead, setAside, candidate.sizeBytes);
      }
      why = read.setAside;
    }
    if (tb.build !== undefined) break;
    // Set aside (or nothing saved): a held result is dropped too; a new one is made from every report — read ONCE, by one
    // read at a time (single-flight): the reports are read, then a small store is folded here and now, a big one in the
    // background. Every fold of those reports uses the fence checked BEFORE they were read.
    setAside = candidate === undefined ? undefined : why;
    if (tb.held === candidate) tb.held = undefined;
    const since = new Date().toISOString();
    // Round 34 · OB-124 (5): the build is single-flight ACROSS head-office processes, not only within this one — it runs
    // only while this process holds the shop's build lease (`snapshots.buildLease`: a PostgreSQL advisory lock on its own
    // connection; none in memory, where this process's guard is the whole story). Without the lease nothing is read here:
    // the reading says "being prepared — another head-office process is building it", and the next read uses its result.
    // Round 35: what was SAVED when this read looked (not a result held in this process's memory, which may be newer) — a
    // different saved one found after taking the lease was saved since, by another process, and is used rather than rebuilt.
    const seenCheck = stored === undefined ? undefined : (boxHistoryFromStore(stored) as BoxHistorySnapshot | undefined)?.check;
    let reportsFor: (all: readonly PersistedEvent[] | undefined) => void = () => undefined;
    let reportsFailed: (e: unknown) => void = () => undefined;
    const events = new Promise<readonly PersistedEvent[] | undefined>((resolve, reject) => { reportsFor = resolve; reportsFailed = reject; });
    events.catch(() => undefined); // its failure is the build's (said as a failed build), never an unhandled rejection
    const build: NonNullable<BoxHistoryTenant['build']> = {
      since, why: why ?? 'nothing usable is saved', events, settledThrough,
      promise: (async (): Promise<void> => {
        let release: BuildLeaseHeld | undefined;
        let leaseKept = false;
        try {
          if (snapshots.buildLease !== undefined) {
            // Round 35 · NEW-4: a lease this process still keeps for a result waiting to be saved is let go first (that
            // result was just set aside, or a new build is needed) — never two sessions of this process on one lease.
            if (tb.keeper !== undefined) { tb.keeper.stop(); await tb.keeper.done; }
            const lease = await snapshots.buildLease(tenantId, BOX_HISTORY_PROJECTION);
            // Round 35 · NEW-2: this process is at its limit of builds at once — this one waits its turn (the next read).
            if (lease === BUILD_LEASES_BUSY_HERE) { if (tb.build?.events === events) tb.build.turn = true; reportsFor(undefined); return; }
            if (lease === undefined) { if (tb.build?.events === events) tb.build.elsewhere = true; reportsFor(undefined); return; }
            release = lease;
            // It may have just finished elsewhere: a result saved since this read looked (readable, sealed) is used, not rebuilt.
            const now = (await snapshots.load<unknown>(tenantId, BOX_HEALTH_STREAM, BOX_HISTORY_PROJECTION))?.result.state;
            const fresh = now === undefined ? undefined : boxHistoryFromStore(now) as BoxHistorySnapshot | undefined;
            if (fresh !== undefined && fresh.check !== seenCheck && boxHistoryUnreadable(fresh, opts.sealKey) === undefined) {
              if (tb.build?.events === events) tb.build.savedElsewhere = true;
              reportsFor(undefined);
              return;
            }
          }
          const all = await store.readStream(tenantId, BOX_HEALTH_STREAM, { type: 'StoreComputerHealthReported' });
          reportsFor(all);
          if (all.length <= BOX_HISTORY_INLINE_MAX) return; // small: each waiting read folds it itself
          // Round 35 · NEW-4: a build whose lease session ended under it stops at its next step.
          const lease = release;
          const step = opts.buildPause ?? breathe;
          const done = await fullRead(at, all, settledThrough, async () => { if (lease?.lost() === true) throw new BoxHistoryBuildLeaseLostError(); await step(); });
          tb.failed = undefined;
          // Round 35 · NEW-4: held back from saving (an open transaction) — the lease is KEPT until it is saved.
          const made = done.read.snapshot;
          // Round 36 · NEW-5: kept OUTSIDE the builds' count (`keep()`), so it never makes another shop wait its turn; with no
          // room left to keep it, it is let go (another process may then build it too — extra work only, never a wrong answer).
          if (lease !== undefined && made !== undefined && tb.held === made && (lease.keep?.() ?? true)) { leaseKept = true; tb.keeper = keepLeaseUntilSaved(lease); }
        } catch (e) {
          reportsFailed(e);
          tb.failed = { at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
        } finally {
          // Round 35 · NEW-3: a failure to let go is said by name where it happens (the lease's own session) — never hidden here.
          if (release !== undefined && !leaseKept) await release();
          if (tb.build?.events === events) tb.build = undefined;
        }
      })(),
    };
    tb.build = build;
    break;
  }
  const b = tb.build;
  if (b === undefined) throw new Error('the box history could not be read');
  const all = await b.events.catch(() => undefined);
  // Round 35 · NEW-4: the result was saved by another process just before this read took the lease — read it now (once).
  if (all === undefined && b.savedElsewhere === true && opts.onceMore !== true) {
    await b.promise;
    const again = await storeComputerHistory(store, tenantId, at, { ...opts, onceMore: true });
    return { ...again, reportsRead: again.reportsRead + reportsRead }; // every report this read took, both times round
  }
  if (all !== undefined && all.length <= BOX_HISTORY_INLINE_MAX) {
    // A small store: read whole, here and now (in steps), as before — with the fence checked before the reports were read.
    reportsRead += all.length;
    const full = await fullRead(at, all, b.settledThrough);
    return finish(full.read, reportsRead, setAside, null);
  }
  const waitMs = opts.waitMs ?? BOX_HISTORY_BUILD_WAIT_MS;
  const waited = !Number.isFinite(waitMs) ? await b.promise.then(() => true)
    : await Promise.race([b.promise.then(() => true), new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), Math.max(0, waitMs)).unref?.(); })]);
  // Round 34 · OB-124 (5): a build that ended because another process holds the lease is not waited for again here.
  if (waited && b.elsewhere !== true && b.turn !== true && tb.build === undefined && tb.failed === undefined) {
    const again = await storeComputerHistory(store, tenantId, at, { ...opts, waitMs: 0 });
    return { ...again, reportsRead: again.reportsRead + reportsRead }; // round 35: every report this read took, both times round
  }
  return { ...await preparing(tb.build ?? b, null), reportsRead }; // round 35: what it read before it found it being prepared
}

/**
 * Round 29 · OB-106 (verifier r28 NEW-2, probe C1 "u-evil"): every (store, prefix) binding a saved result carries must be
 * traceable to what it came from — an owner-approved act (the same id, store, prefix, computer and time) or a report from
 * THAT store computer naming THAT prefix at the binding's time (one indexed read of the reports at that moment). A binding
 * that cannot be traced sets the result aside. Answers why, or undefined when every binding is traced.
 */
async function bindingsTraced(store: EventStore, tenantId: string, s: BoxHistorySnapshot, replacements: readonly StoreComputerReplacement[], counted: (rows: number) => void = () => undefined): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const b of [...s.never.bound, ...s.rawBound]) {
    const key = `${b.storeId}\u0000${b.prefix}\u0000${b.computer}\u0000${b.since}\u0000${b.via}\u0000${b.replacementId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (b.via === 'replacement') {
      const m = replacements.find((x) => x.replacementId === b.replacementId);
      if (m === undefined || m.storeId !== b.storeId || m.prefix !== b.prefix || m.to !== b.computer || Date.parse(m.at) !== Date.parse(b.since)) {
        return `unreadable: its binding of ${b.prefix} (store ${b.storeId}) to ${b.computer} names no such "store computer replaced" act`;
      }
      continue;
    }
    const ms = Date.parse(b.since);
    const there = await store.readStream(tenantId, BOX_HEALTH_STREAM, { type: 'StoreComputerHealthReported', from: new Date(ms - 1_000).toISOString(), to: new Date(ms + 1_000).toISOString() });
    counted(there.length); // round 35: every report a read takes from the store is in its count (reportsRead)
    const named = there.some((e) => {
      const r = e.event.payload as BoxHealthRecord;
      return r.storeId === b.storeId && r.reportedBy === b.computer && Date.parse(r.receivedAt) === ms && (r.receiptNumbersIssued ?? []).some((x) => x.prefix === b.prefix);
    });
    if (!named) return `unreadable: its binding of ${b.prefix} (store ${b.storeId}) to ${b.computer} names no report from that store computer at ${b.since}`;
  }
  return undefined;
}

/**
 * Round 29 · OB-106: the store computers' saved history for the health read — never on the request path's critical work for
 * long (see BUILDING THE SAVED HISTORY). Exported for the tests: a build in progress for this tenant, to wait for.
 */
export function boxHistoryBuilding(snapshots: SnapshotStore, tenantId: string): Promise<void> | undefined {
  return BOX_HISTORY_TENANTS.get(snapshots)?.get(tenantId)?.build?.promise;
}
/** Round 35 · NEW-4: the build lease kept until a built result is saved, when there is one (tests and support). */
export function boxHistoryLeaseKept(snapshots: SnapshotStore, tenantId: string): Promise<void> | undefined {
  return BOX_HISTORY_TENANTS.get(snapshots)?.get(tenantId)?.keeper?.done;
}
/** Round 39 · verifier r37 L4: how many reports the result held back from saving has folded (tests and support), if one is held. */
export function boxHistoryHeldCount(snapshots: SnapshotStore, tenantId: string): number | undefined {
  return BOX_HISTORY_TENANTS.get(snapshots)?.get(tenantId)?.held?.ord;
}

/**
 * Round 27/28: the part of a store-computer reading after the folds — every never-received candidate checked against the ledger
 * (r19…r26), and every number a store computer said it never used checked for a bill head office holds (OB-100) — then each
 * store's findings in the owner's words (`findingsFor`: from the reports, or from the saved running result's facts).
 */
async function finishStoreComputerReading(
  store: EventStore, tenantId: string, at: string,
  read: { readonly candidates: readonly UnreceivedCandidate[]; readonly unused: ReadonlyMap<string, readonly UnusedNumbers[]> },
  banked: ReadonlyMap<string, number>, claimSlack: ClaimSlack | undefined, storeIds: ReadonlySet<string> | readonly string[],
  findingsFor: (storeId: string, unreceived: readonly UnreceivedNumbers[], unusedReceived: readonly UnusedReceived[] | undefined, unusedCapped: readonly UnusedCheckCapped[] | undefined) => BillNumberFinding[],
): Promise<{ findings: ReadonlyMap<string, readonly BillNumberFinding[]>; unused: ReadonlyMap<string, readonly UnusedNumbers[]>; unusedReceived: ReadonlyMap<string, readonly UnusedReceived[]>; unusedCapped: ReadonlyMap<string, readonly UnusedCheckCapped[]> }> {
  const candidates = read.candidates;
  // Round 29 · OB-108, round 34 · OB-124 (1): a return's time is the store computer's (when it took the refund — stamped by the
  // store computer since round 34, kept on the return by the synced-return routes), when it stamped one; else the till's.
  let refundTimes: Map<string, { at: string; clock: 'store_computer' | 'till' }> | undefined;
  const refunds = async (): Promise<Map<string, { at: string; clock: 'store_computer' | 'till' }>> => {
    refundTimes ??= new Map((await store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded' })).map((e) => {
      const p = e.event.payload as { number?: unknown; storeComputerTakenAt?: unknown };
      const boxAt = storeComputerTimeOf(p.storeComputerTakenAt);
      return [String(p.number ?? ''), boxAt === undefined ? { at: e.event.occurredAt, clock: 'till' as const } : { at: boxAt, clock: 'store_computer' as const }] as const;
    }));
    return refundTimes;
  };
  const unreceived = new Map<string, UnreceivedNumbers[]>();
  const numberOf = (prefix: string, n: number): string => `${prefix}${String(n).padStart(RECEIPT_COUNTER_DIGITS, '0')}`;
  const heldKeys = async (keys: readonly string[]): Promise<ReadonlySet<string>> => (store.existingIdempotencyKeys !== undefined
    ? store.existingIdempotencyKeys(tenantId, keys)
    : new Set((await Promise.all(keys.map(async (k) => ((await store.findByIdempotencyKey(tenantId, k)) === undefined ? undefined : k)))).filter((k): k is string => k !== undefined)));
  for (const c of candidates) {
    const top = banked.get(c.prefix) ?? 0;
    const toCheck = c.numbers.filter((n) => n <= top);
    const missing = c.numbers.filter((n) => n > top);
    if (toCheck.length > 0) {
      const held = await heldKeys(toCheck.map((n) => `receipt-${tenantId}-${numberOf(c.prefix, n)}`));
      for (const n of toCheck) {
        const number = numberOf(c.prefix, n);
        if (held.has(`receipt-${tenantId}-${number}`)) continue;
        if ((await refunds()).has(number)) continue;
        missing.push(n);
      }
    }
    missing.sort((a, b) => a - b);
    // Verifier r22 D5: a sparse claim accounts for the numbers head office lacks in its spans only when they are no more
    // than the bills it says it holds there; outnumbered, every one is named (and said to be possibly on the box).
    // Verifier r23 NEW-1 · OB-89: a number the box said it no longer held, and claims again, is never accounted for by its
    // (sparse) claim — it is named whatever the claim says.
    const reclaimed = new Set(c.reclaimed?.numbers ?? []);
    const weighed = weighSparseClaim(missing.filter((n) => !reclaimed.has(n)), c.sparse, claimSlack);
    const back = missing.filter((n) => reclaimed.has(n));
    const numbers = back.length === 0 ? weighed.numbers : [...weighed.numbers, ...back].sort((a, b) => a - b);
    if (numbers.length > 0) {
      unreceived.set(c.storeId, [...(unreceived.get(c.storeId) ?? []), {
        prefix: c.prefix, numbers, since: c.since, capped: c.capped,
        ...(weighed.outnumbered && c.sparse !== undefined ? { sparse: c.sparse } : {}),
        ...(c.wholeQueue === undefined ? {} : { wholeQueue: c.wholeQueue }),
        ...(back.length === 0 || c.reclaimed === undefined ? {} : { reclaimed: { numbers: back, saidGoneAt: c.reclaimed.saidGoneAt, byList: c.reclaimed.byList } }),
      }]);
    }
  }
  // Round 27 · OB-100 (verifier r26 NEW-1, probes U1/U4): a number a store computer said it never used that head office
  // HOLDS a bill for — checked against the ledger: the newest UNRECEIVED_CHECK_CAP such numbers at or below banked per
  // prefix (above banked, head office holds no bill by definition), in ONE indexed read per prefix; the bill's own time is
  // read only for the ones held (`unusedButReceived`: said unused after the bill was made) — at most UNUSED_HELD_TIMED_MAX of
  // them per prefix (the newest), so an altered store computer calling 500 banked numbers unused costs a bounded read.
  const unusedReceived = new Map<string, UnusedReceived[]>();
  const unusedCapped = new Map<string, UnusedCheckCapped[]>();
  for (const [storeId, list] of read.unused) {
    for (const u of list) {
      const top = banked.get(u.prefix) ?? 0;
      const numbers: number[] = [];
      let atOrBelow = 0;
      for (const run of u.runs) if (run.from <= top) atOrBelow += Math.min(run.to, top) - run.from + 1;
      for (let i = u.runs.length - 1; i >= 0 && numbers.length < UNRECEIVED_CHECK_CAP; i -= 1) {
        const run = u.runs[i]!;
        for (let n = Math.min(run.to, top); n >= run.from && numbers.length < UNRECEIVED_CHECK_CAP; n -= 1) numbers.push(n);
      }
      if (numbers.length === 0) continue;
      const held = await heldKeys(numbers.map((n) => `receipt-${tenantId}-${numberOf(u.prefix, n)}`));
      const at = new Map<number, { as: 'sale' | 'return'; at: string; clock: 'store_computer' | 'till' }>();
      let timed = 0;
      let notTimed = 0;
      for (const n of numbers) {
        const key = `receipt-${tenantId}-${numberOf(u.prefix, n)}`;
        if (held.has(key)) {
          // Verifier r28 NEW-6 (a): beyond the newest UNUSED_HELD_TIMED_MAX held, counted (and said), never silently left.
          if (timed >= UNUSED_HELD_TIMED_MAX) { notTimed += 1; continue; }
          timed += 1;
          const e = await store.findByIdempotencyKey(tenantId, key);
          // Round 29 · OB-108: the store computer's own time for the bill (it took it from the till) — else the till's.
          const boxAt = storeComputerTimeOf((e?.event.payload as { storeComputerTakenAt?: unknown } | undefined)?.storeComputerTakenAt);
          if (e !== undefined) at.set(n, boxAt === undefined ? { as: 'sale', at: e.event.occurredAt, clock: 'till' } : { as: 'sale', at: boxAt, clock: 'store_computer' });
          continue;
        }
        if (timed >= UNUSED_HELD_TIMED_MAX) continue;
        const back = (await refunds()).get(numberOf(u.prefix, n));
        if (back !== undefined) at.set(n, { as: 'return', at: back.at, clock: back.clock });
      }
      const notChecked = Math.max(0, atOrBelow - numbers.length);
      if (notChecked > 0 || notTimed > 0) unusedCapped.set(storeId, [...(unusedCapped.get(storeId) ?? []), { prefix: u.prefix, notChecked, notTimed }]);
      const found = unusedButReceived(u.prefix, u, at);
      if (found.length > 0) unusedReceived.set(storeId, [...(unusedReceived.get(storeId) ?? []), ...found]);
    }
  }
  const out = new Map<string, readonly BillNumberFinding[]>();
  for (const storeId of storeIds) {
    const f = findingsFor(storeId, unreceived.get(storeId) ?? [], unusedReceived.get(storeId), unusedCapped.get(storeId));
    if (f.length > 0) out.set(storeId, f);
  }
  return { findings: out, unused: read.unused, unusedReceived, unusedCapped };
}

/**
 * Round 29 · OB-108: the store computer's own time for a bill, as head office keeps it — only a well-formed time is used (a
 * missing or unreadable one leaves the till's time, said so on the line).
 */
function storeComputerTimeOf(v: unknown): string | undefined {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;
}

/** OB-81: the store pack's `receiptSeries` for one store — each till's current issued prefix. */
export async function issuedReceiptSeries(store: EventStore, tenantId: string, storeId: string): Promise<ReturnType<typeof issuedSeriesFor>> {
  return issuedSeriesFor(await allOf<ReceiptPrefixIssue>(store, tenantId, RECEIPT_PREFIX_STREAM, 'TillReceiptPrefixIssued'), storeId);
}

/**
 * Verifier r17 (a replaced box) · OB-85: the highest 6-digit count head office holds BANKED under each bill-number prefix —
 * from the sales' receipt-number index and the returns' numbers (both drawn from a till's one register). The store pack
 * carries it per series (`bankedThrough`) so a box whose disk was lost resumes above it and never repeats a bill number.
 * Read-only. Every number is |P| + 6 characters, so the prefix is everything before the last six (contracts).
 */
export async function bankedReceiptCounts(
  store: EventStore, tenantId: string, opts?: { readonly snapshots?: SnapshotStore; readonly storeId?: string },
): Promise<ReadonlyMap<string, number>> {
  const snapshots = opts?.snapshots ?? processHighWaterSnapshots(store);
  const out = new Map<string, number>();
  const raise = (prefix: string, count: number): void => { if (count > (out.get(prefix) ?? 0)) out.set(prefix, count); };
  for (const [prefix, count] of await receiptHighWater(store, snapshots, tenantId, STREAM.sales, 'ReceiptNumberIssued', (p) => numberKey((p as { receiptNumber?: unknown }).receiptNumber))) raise(prefix, count);
  for (const [prefix, count] of await receiptHighWater(store, snapshots, tenantId, STREAM.returns, 'ReturnRecorded', (p) => numberKey((p as { number?: unknown }).number))) raise(prefix, count);
  // Verifier r18 item 6: what the store's OWN boxes say they have given (a voided or abandoned bill keeps its number) — only
  // for the store the pack is for, so one store's box never moves another store's count.
  if (opts?.storeId !== undefined) {
    const reported = await receiptHighWater(store, snapshots, tenantId, BOX_HEALTH_STREAM, 'StoreComputerHealthReported', (p) => {
      const r = p as { storeId?: unknown; receiptNumbersIssued?: unknown };
      if (typeof r.storeId !== 'string' || !Array.isArray(r.receiptNumbersIssued)) return [];
      return (r.receiptNumbersIssued as { prefix?: unknown; through?: unknown }[]).flatMap((x) =>
        (typeof x.prefix === 'string' && typeof x.through === 'number' && Number.isSafeInteger(x.through) && x.through >= 1 && x.through <= RECEIPT_COUNTER_MAX
          ? [[`${r.storeId as string}${BOX_KEY_SEP}${x.prefix}`, x.through] as const] : []));
    });
    const mine = `${opts.storeId}${BOX_KEY_SEP}`;
    // Verifier r19 BOX-1: only this store's own prefixes (issued to one of its tills, or — round 33 · OB-121 — one of its store
    // computers' REGISTERED lane prefixes) — also for a report kept before head office judged reports at arrival.
    const issued = await issuedPrefixStores(store, tenantId);
    const registeredHere = registeredByStore(await lanePrefixRegistrationsOf(store, tenantId)).get(opts.storeId) ?? new Set<string>();
    const own = (prefix: string): boolean => (issued.get(prefix)?.has(opts.storeId!) ?? false) || (registeredHere.has(prefix) && !issued.has(prefix));
    // Verifier r20 BOX-2: and only up to PLAUSIBLE_ISSUED_AHEAD above what sales and refunds bank — the same bound head
    // office judges a report by at arrival, so a report kept before that judging can never lock a till either.
    // The running maximum is exact while it is plausible; when it is not (an implausible report kept before judging), the
    // highest PLAUSIBLE count for that prefix is read from this store's reports — a rare path, only for that anomaly.
    const fromLedger = new Map(out);
    const capOf = (prefix: string): number => (fromLedger.get(prefix) ?? 0) + PLAUSIBLE_ISSUED_AHEAD;
    let implausible = false;
    for (const [key, count] of reported) {
      const prefix = key.slice(mine.length);
      if (!key.startsWith(mine) || !own(prefix)) continue;
      if (count <= capOf(prefix)) raise(prefix, count); else implausible = true;
    }
    if (implausible) {
      // Verifier r21 (cost): the plausible maximum is kept in a snapshot (`plausibleReportedCounts`), so the whole stream is
      // read ONCE — later pack builds read only the reports since.
      for (const [key, count] of await plausibleReportedCounts(store, snapshots, tenantId, capOf)) {
        const prefix = key.slice(mine.length);
        if (key.startsWith(mine) && own(prefix)) raise(prefix, count);
      }
    }
  }
  return out;
}

/**
 * Verifier r21 (cost) — the highest PLAUSIBLE count each store's box reported per prefix (store␟prefix → count), for the
 * rare store with an implausible report kept before head office judged reports at arrival. Before, every pack build for that
 * store re-read the WHOLE box-health stream for as long as that report existed; now the answer is SNAPSHOTTED:
 *   • per key, the highest count at or below the cap (`plausible`) and the distinct counts above it (`above`, kept because
 *     the cap — banked + PLAUSIBLE_ISSUED_AHEAD — only ever rises, so a count above it today may be plausible tomorrow;
 *     each read re-judges them against today's cap);
 *   • the snapshot advances only over reports at least HIGH_WATER_LAG positions behind the newest read (an append that
 *     commits late is still in the tail), and only every HIGH_WATER_EVERY reports, as the receipt high-water does.
 * So the full stream is read once; afterwards a read is the snapshot plus a short tail. (A report missed by a very late
 * commit would only under-state one pass — the box re-reports its running counts every pass.) Disposable: delete the
 * snapshot and the next read rebuilds the same answer.
 */
const BOX_PLAUSIBLE_PROJECTION = 'box-reported-plausible@1';
interface BoxPlausibleState { readonly keys: Record<string, { readonly plausible: number; readonly above: readonly number[] }> }
async function plausibleReportedCounts(
  store: EventStore, snapshots: SnapshotStore, tenantId: string, capOf: (prefix: string) => number,
): Promise<ReadonlyMap<string, number>> {
  const base = (await snapshots.load<BoxPlausibleState>(tenantId, BOX_HEALTH_STREAM, BOX_PLAUSIBLE_PROJECTION))?.result;
  const tail = [...await store.readStream(tenantId, BOX_HEALTH_STREAM, { sinceSeq: base?.watermarkSeq ?? 0, type: 'StoreComputerHealthReported' })].sort((a, b) => a.seq - b.seq);
  type Keyed = Map<string, { plausible: number; above: Set<number> }>;
  const prefixOf = (key: string): string => key.slice(key.indexOf(BOX_KEY_SEP) + 1);
  const put = (m: Keyed, key: string, count: number): void => {
    const cur = m.get(key) ?? { plausible: 0, above: new Set<number>() };
    if (count <= capOf(prefixOf(key))) { if (count > cur.plausible) cur.plausible = count; } else cur.above.add(count);
    m.set(key, cur);
  };
  const fold = (m: Keyed, payload: unknown): void => {
    const r = payload as { storeId?: unknown; receiptNumbersIssued?: unknown };
    if (typeof r.storeId !== 'string' || !Array.isArray(r.receiptNumbersIssued)) return;
    for (const x of r.receiptNumbersIssued as { prefix?: unknown; through?: unknown }[]) {
      if (typeof x.prefix !== 'string' || typeof x.through !== 'number' || !Number.isSafeInteger(x.through) || x.through < 1 || x.through > RECEIPT_COUNTER_MAX) continue;
      put(m, `${r.storeId}${BOX_KEY_SEP}${x.prefix}`, x.through);
    }
  };
  // The snapshot's state, re-judged against today's cap (a count above yesterday's cap may be within today's).
  const fromBase = (): Keyed => {
    const m: Keyed = new Map();
    for (const [key, v] of Object.entries(base?.state.keys ?? {})) {
      m.set(key, { plausible: v.plausible, above: new Set<number>() });
      for (const a of v.above) put(m, key, a);
    }
    return m;
  };
  const settled = tail.slice(0, Math.max(0, tail.length - HIGH_WATER_LAG));
  if (settled.length >= HIGH_WATER_EVERY || (base === undefined && settled.length > 0)) {
    const snap = fromBase();
    for (const e of settled) fold(snap, e.event.payload);
    const last = settled[settled.length - 1]!;
    await snapshots.save<BoxPlausibleState>({
      tenantId, stream: BOX_HEALTH_STREAM, projection: BOX_PLAUSIBLE_PROJECTION, takenAt: last.event.occurredAt,
      result: {
        state: { keys: Object.fromEntries([...snap].map(([k, v]) => [k, { plausible: v.plausible, above: [...v.above].sort((a, b) => a - b) }])) },
        watermarkSeq: last.seq, lastEventAt: last.event.occurredAt, eventCount: (base?.eventCount ?? 0) + settled.length,
      },
    });
  }
  const out = fromBase();
  for (const e of tail) fold(out, e.event.payload);
  return new Map([...out].filter(([, v]) => v.plausible > 0).map(([k, v]) => [k, v.plausible]));
}

/**
 * The separator in a store-and-prefix key that is SAVED in a snapshot. Verifier r21 (found by the cost proof): it was NUL
 * (\u0000), which PostgreSQL's jsonb refuses ("unsupported Unicode escape sequence") — so on the production database the
 * box-health high-water snapshot could never be saved, and once a store's box had sent enough reports every store-pack build
 * for that store failed. The unit separator (U+001F) is valid in jsonb and in no store id or bill-number prefix.
 */
const BOX_KEY_SEP = '\u001f';

const numberKey = (n: unknown): (readonly [string, number])[] => {
  const s = splitReceiptNumber(n);
  return s === undefined ? [] : [[s.prefix, s.counter]];
};

/**
 * Verifier r18 OB85-2 (cost): the highest count per key on one stream's events of one type, kept INCREMENTALLY — a snapshot
 * of the running maxima at a stream position (the SnapshotStore: `projection_snapshot` on PostgreSQL), and only the tail
 * behind it read on each call. So a pack build reads O(prefixes) of snapshot plus a short tail, never every sale ever made.
 *
 * A maximum is idempotent and order-free, so folding an event twice is harmless; the snapshot is advanced only over events
 * at least `HIGH_WATER_LAG` positions behind the newest read, so an append whose transaction commits a little after a later
 * one (PostgreSQL hands out positions before commit) is still in the tail when it lands. Disposable: delete every snapshot
 * and the next read rebuilds the same answer from the ledger (proved equal to a full scan by test).
 */
const HIGH_WATER_LAG = 256;
const HIGH_WATER_EVERY = 64;
const HIGH_WATER_PROJECTION = 'receipt-high-water@1';
/**
 * Verifier r19 HW-1: with a store that offers a visibility fence (PostgreSQL, memory), the snapshot advances only to a
 * position every transaction below which has FINISHED — never by a count of events — so a bill whose transaction drew its
 * position early and committed after hundreds of others is still read when it lands. A fence that has not settled yet is
 * kept in the snapshot and used once it has. (`@2`: a new state shape; `@1` snapshots are simply not read.)
 */
const HIGH_WATER_FENCED = 'receipt-high-water@2';
interface FencedHighWater { readonly maxima: Record<string, number>; readonly pending?: { readonly seq: number; readonly token: string; readonly since?: string } }
/**
 * Verifier r20 HW-2 (P-08): the fence each high-water fold is waiting on, and since when (this process's clock) — per
 * snapshot store, per tenant + stream + type. A fence normally settles within milliseconds; one that does not is held
 * back by a transaction still open somewhere on the database cluster (transaction ids are cluster-wide), and the fold
 * then re-reads every bill since it. Read by the health check (`highWaterFenceWait`), never by the count itself.
 */
const HIGH_WATER_WAITS = new WeakMap<SnapshotStore, Map<string, { readonly token: string; readonly seq: number; readonly since: string }>>();
async function receiptHighWater(
  store: EventStore, snapshots: SnapshotStore, tenantId: string, stream: string, type: string,
  keysOf: (payload: unknown) => readonly (readonly [string, number])[],
): Promise<ReadonlyMap<string, number>> {
  if (store.positionFence !== undefined && store.fenceSettled !== undefined) return fencedHighWater(store, snapshots, tenantId, stream, type, keysOf);
  const name = `${HIGH_WATER_PROJECTION}:${type}`;
  const prior = await snapshots.load<Record<string, number>>(tenantId, stream, name);
  const base = prior?.result;
  const tail = [...await store.readStream(tenantId, stream, { sinceSeq: base?.watermarkSeq ?? 0, type })].sort((a, b) => a.seq - b.seq);
  const fold = (m: Map<string, number>, payload: unknown): void => {
    for (const [k, c] of keysOf(payload)) if (c > (m.get(k) ?? 0)) m.set(k, c);
  };
  const out = new Map<string, number>(Object.entries(base?.state ?? {}));
  if (tail.length >= HIGH_WATER_LAG + HIGH_WATER_EVERY) {
    const settled = tail.slice(0, tail.length - HIGH_WATER_LAG);
    const snap = new Map(out);
    for (const e of settled) fold(snap, e.event.payload);
    const last = settled[settled.length - 1]!;
    await snapshots.save<Record<string, number>>({
      tenantId, stream, projection: name, takenAt: last.event.occurredAt,
      result: { state: Object.fromEntries(snap), watermarkSeq: last.seq, lastEventAt: last.event.occurredAt, eventCount: (base?.eventCount ?? 0) + settled.length },
    });
  }
  for (const e of tail) fold(out, e.event.payload);
  return out;
}

async function fencedHighWater(
  store: EventStore, snapshots: SnapshotStore, tenantId: string, stream: string, type: string,
  keysOf: (payload: unknown) => readonly (readonly [string, number])[],
): Promise<ReadonlyMap<string, number>> {
  const name = `${HIGH_WATER_FENCED}:${type}`;
  const base = (await snapshots.load<FencedHighWater>(tenantId, stream, name))?.result;
  const watermark = base?.watermarkSeq ?? 0;
  const pending = base?.state.pending;
  // Both checks BEFORE the tail is read, so the read sees everything a settled fence covers.
  const pendingSettled = pending !== undefined && await store.fenceSettled!(tenantId, pending.token);
  const fresh = await store.positionFence!(tenantId, stream);
  const freshSettled = await store.fenceSettled!(tenantId, fresh.token);
  const tail = [...await store.readStream(tenantId, stream, { sinceSeq: watermark, type })].sort((a, b) => a.seq - b.seq);
  const fold = (m: Map<string, number>, payload: unknown): void => {
    for (const [k, c] of keysOf(payload)) if (c > (m.get(k) ?? 0)) m.set(k, c);
  };
  const out = new Map<string, number>(Object.entries(base?.state.maxima ?? {}));
  const advanceTo = Math.max(watermark, freshSettled ? fresh.seq : pendingSettled ? pending.seq : watermark);
  const settled = tail.filter((e) => e.seq <= advanceTo);
  // The fence to wait for next: none when the fresh one has settled; the fresh one once the old one is used; else the old one.
  const nextPending: FencedHighWater['pending'] = freshSettled ? undefined
    : pendingSettled || pending === undefined ? { ...fresh, since: new Date().toISOString() } : pending;
  // Verifier r20 HW-2: remember what the fold waits on, and since when, for the health check.
  const waits = HIGH_WATER_WAITS.get(snapshots) ?? new Map<string, { token: string; seq: number; since: string }>();
  HIGH_WATER_WAITS.set(snapshots, waits);
  const waitKey = `${tenantId}\u0000${stream}\u0000${type}`;
  // The OLDEST fence still unsettled is kept, so "since" is when the stalling transaction was first seen — a busy shop's
  // ordinary short transactions settle within milliseconds and never accumulate into a false "waiting".
  if (nextPending === undefined) waits.delete(waitKey);
  else {
    const held = waits.get(waitKey);
    if (held === undefined || (held.token !== nextPending.token && await store.fenceSettled!(tenantId, held.token))) {
      waits.set(waitKey, { token: nextPending.token, seq: nextPending.seq, since: nextPending.since ?? new Date().toISOString() });
    }
  }
  const pendingChanged = nextPending?.token !== pending?.token || nextPending?.seq !== pending?.seq;
  if (settled.length >= HIGH_WATER_EVERY || (pendingChanged && tail.length >= HIGH_WATER_EVERY)) {
    const snap = new Map<string, number>(Object.entries(base?.state.maxima ?? {}));
    for (const e of settled) fold(snap, e.event.payload);
    const last = settled[settled.length - 1];
    await snapshots.save<FencedHighWater>({
      tenantId, stream, projection: name, takenAt: last?.event.occurredAt ?? base?.lastEventAt ?? new Date(0).toISOString(),
      result: {
        state: { maxima: Object.fromEntries(snap), ...(nextPending === undefined ? {} : { pending: nextPending }) },
        watermarkSeq: last?.seq ?? watermark, lastEventAt: last?.event.occurredAt ?? base?.lastEventAt ?? null,
        eventCount: (base?.eventCount ?? 0) + settled.length,
      },
    });
  }
  for (const e of tail) fold(out, e.event.payload);
  return out;
}

/**
 * Verifier r20 HW-2 (P-08): is the bill-number high-water waiting on an open database transaction, and since when? From the
 * folds this process ran (`HIGH_WATER_WAITS`), else the fence a kept snapshot is waiting on — each re-checked NOW, so a
 * transaction that has since ended reads as settled. `undefined`: nothing is waiting.
 */
export async function highWaterFenceWait(
  store: EventStore, tenantId: string, opts?: { readonly snapshots?: SnapshotStore },
): Promise<{ readonly since: string; readonly waitingSeconds: number; readonly streams: readonly string[] } | undefined> {
  if (store.fenceSettled === undefined || store.positionFence === undefined) return undefined;
  const snapshots = opts?.snapshots ?? processHighWaterSnapshots(store);
  const waits = HIGH_WATER_WAITS.get(snapshots);
  let since: string | undefined;
  const streams: string[] = [];
  for (const [stream, type] of [[STREAM.sales, 'ReceiptNumberIssued'], [STREAM.returns, 'ReturnRecorded']] as const) {
    const w = waits?.get(`${tenantId}\u0000${stream}\u0000${type}`)
      ?? (await snapshots.load<FencedHighWater>(tenantId, stream, `${HIGH_WATER_FENCED}:${type}`))?.result.state.pending;
    if (w === undefined || w.since === undefined || await store.fenceSettled(tenantId, w.token)) continue;
    streams.push(stream);
    if (since === undefined || Date.parse(w.since) < Date.parse(since)) since = w.since;
  }
  return since === undefined ? undefined : { since, waitingSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000)), streams };
}

/** A process-local snapshot store per event store, when the composition gives none (still correct: a snapshot is disposable). */
const HIGH_WATER_SNAPSHOTS = new WeakMap<EventStore, SnapshotStore>();
function processHighWaterSnapshots(store: EventStore): SnapshotStore {
  let s = HIGH_WATER_SNAPSHOTS.get(store);
  if (s === undefined) { s = new InMemorySnapshotStore(); HIGH_WATER_SNAPSHOTS.set(store, s); }
  return s;
}

/**
 * The FULL scan `bankedReceiptCounts` replaced (verifier r18 OB85-2) — kept only as the reference the incremental answer is
 * proved equal to (tests/performance). Never on a request path.
 */
export async function bankedReceiptCountsByFullScan(store: EventStore, tenantId: string): Promise<ReadonlyMap<string, number>> {
  const out = new Map<string, number>();
  const note = (n: unknown): void => {
    const s = splitReceiptNumber(n);
    if (s !== undefined && s.counter > (out.get(s.prefix) ?? 0)) out.set(s.prefix, s.counter);
  };
  for (const e of await store.readStream(tenantId, STREAM.sales, { type: 'ReceiptNumberIssued' })) note((e.event.payload as { receiptNumber?: unknown }).receiptNumber);
  for (const e of await store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded' })) note((e.event.payload as { number?: unknown }).number);
  return out;
}
