// Browser entry — the bundler's input for the store manager screen (`pnpm build:erp`). It wires a
// real `ManagerSession` and attaches it as `window.managerSession`, which `web/app.js` binds to.
//
// ── What this screen may and may not assume ─────────────────────────────────
//
// The manager's browser can see its own tab and nothing else. It cannot see the lanes' queues, the
// edge's outbox, or the exception register — those live on the store box, and the ERP server hands
// them over as a **last-synced payload** (`window.managerData`), the same pattern the owner app
// uses for the daily brief.
//
// **When that payload is absent, every register answers "not known", and the day cannot close.**
// That is not a degraded mode to be tidied up later; it is the correct answer. A manager screen
// that reported "0 exceptions" because it was not plugged in yet would let somebody lock a trading
// day on the strength of a page that had never spoken to the store.
//
// The stock ledger and outbox here are this session's own: a receipt or a count booked from this
// screen is committed locally and queued, and the sync agent drains it. Nothing in this file calls
// the network in a path a person waits on.

import { InMemoryLedgerStore, Ledger } from '../../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { openDeviceOutbox, guardedStore } from '../../../packages/sync/src/device-outbox';
import { makeTradingDayRule } from '../../../packages/calendar/src/trading-day';
import {
  APPROVE_REASONS,
  REJECT_REASONS,
  createManagerSession,
  disconnectedPorts,
  notKnown,
  type ApprovalRegister,
  type BoxCloseOutcome,
  type DecisionReasonCode,
  type ManagerPorts,
  type ManagerSession,
  type Register,
  type RegisterItem,
  type ValueRegister,
} from './manager-session';
import type { ApprovalRequest } from '../../../packages/approvals/src/approvals';
import {
  createBuyingSession,
  type BuyingPorts, type BuyingSession, type InvoiceLine,
  type ProposePurchaseOrderPort, type ProposePurchaseOrderOutcome,
} from './buying-session';
import {
  createCatalogueSession,
  type CataloguePorts, type CatalogueSession,
  type PromotionLaunchPort, type PromotionLaunchOutcome,
  type PriceChangeCloudPort, type PriceChangeCloudOutcome,
} from './catalogue-session';
import { bootWarehouseSupervisor, type SupervisorData, type WarehouseSupervisorSession } from './warehouse-supervisor-session';
import type { Category, ProductRecord } from '../../../packages/product/src/index';
import type { CostRegister, PriceEntry } from '../../../packages/price-list/src/index';
import type { Promotion } from '../../../packages/promotions/src/index';
import type { Money } from '../../../packages/contracts/src/money';
import {
  Assortment, ShelfMap,
  type AssortmentEntry, type DisplayContract, type Planogram, type ShelfAssignment,
  type ShelfCount, type ShelfLocation, type SpaceArea,
} from '../../../packages/merchandising/src/index';
import {
  createMerchandisingSession,
  type MerchandisingPorts, type MerchandisingSession,
} from './merchandising-session';
import {
  createReportingSession,
  type DayTotal, type ReportableSale, type ReportingPorts, type ReportingSession,
} from './reporting-session';
import { AccessControl, type Role, type RoleAssignment } from '../../../packages/rbac/src/index';
import {
  createServiceSession, type ServicePorts, type ServiceSession,
} from './service-session';
import type { OriginalSale, RecordedReturn } from '../../../packages/returns/src/index';
import type { SatisfactionScore, ServiceCase, SlaPolicy } from '../../../packages/service-desk/src/index';
import {
  createExpirySession, type ExpiryPorts, type ExpirySession, type RecallRecord,
  type RecallCloudPort, type RecallCloudResult,
} from './expiry-session';
import type { Batch } from '../../../packages/fefo/src/index';
import {
  createFinanceSession, type FinancePorts, type FinanceSession,
} from './finance-session';
import {
  createGstReconciliationSession, type GstReconciliationPorts, type GstReconciliationSession, type QueueRow as GstQueueRow,
} from './gst-reconciliation-session';
import {
  createPayrollSession, type PayrollPorts, type PayrollSession, type EmployeeInput as PayrollEmployeeInput,
} from './payroll-session';
import {
  createPayrollEssSession, type PayrollEssPorts, type PayrollEssSession,
} from './payroll-ess-session';
import {
  createCategoryPolicySession, type CategoryPolicyPorts, type CategoryPolicySession,
} from './category-policy-session';
import {
  createEssSession, type EssPorts, type EssSession, type EssRoster, type EssPayslip,
} from './ess-session';
import {
  createGstReturnsSession, type GstReturnsPorts, type GstReturnsSession, type ReturnRow as GstReturnRow,
} from './gst-returns-session';
import {
  createWasteReviewSession, type WasteReviewPorts, type WasteReviewSession, type WriteOffRow,
} from './waste-review-session';
import {
  createWriteOffCaptureSession,
  type WriteOffCapturePorts, type WriteOffCaptureSession, type WriteOffCapturePort, type CaptureResult,
} from './write-off-capture-session';
import { DEFAULT_WRITE_OFF_THRESHOLD_MINOR } from '../../../packages/waste/src/waste';
import {
  createCountsReviewSession, type CountsReviewPorts, type CountsReviewSession, type CountRow,
} from './counts-session';
import {
  createDataQualityInboxSession,
  type DataQualityInboxPorts, type DataQualityInboxSession, type DataQualityWorklistData,
  type DataQualityDismissPort, type DismissOutcome,
} from './data-quality-inbox-session';
import {
  createOperationsInboxSession,
  type OperationsInboxPorts, type OperationsInboxSession, type OperationsWorklistData,
  type OperationsDismissPort,
} from './operations-inbox-session';
import {
  createLpInboxSession,
  type LpInboxPorts, type LpInboxSession, type LpWorklistData, type LpCloseCasePort, type CloseResult,
} from './loss-prevention-inbox-session';
import {
  createReturnGovernanceSession,
  type ReturnGovernancePorts, type ReturnGovernanceSession, type ReturnGovernanceData as ReturnGovernanceExceptions,
} from './return-governance-session';
import {
  createRosteringSession,
  type RosteringPorts, type RosteringSession, type RosteringData, type AssignPort, type AssignResult,
} from './rostering-session';
import {
  createChecklistSession,
  type ChecklistPorts, type ChecklistSession, type ChecklistData, type StoredChecklist,
  type SubmitChecklistPort, type SubmitResult as ChecklistSubmitResult,
} from './checklist-session';
import {
  createProductionSession,
  type ProductionPorts, type ProductionSession, type ProductionData, type ProductionRun,
  type ReleasePort, type ReleaseResult,
} from './production-session';
import {
  createFacilitiesSession,
  type FacilitiesPorts, type FacilitiesSession, type FacilitiesData, type OverdueTask,
  type CompletePort, type CompleteResult,
} from './facilities-session';
import {
  createCashOfficeSession,
  type CashOfficePorts, type CashOfficeSession, type CashOverShortData, type OverShortView,
  type OverShortSignOffPort, type SignOffResult,
} from './cash-office-session';
import {
  createRiskAcceptanceSession,
  type RiskAcceptancePorts, type RiskAcceptanceSession, type BlockedGatesData, type GateBlockView,
  type RiskAcceptPort, type AcceptResult,
} from './risk-acceptance-session';
import {
  createDayReopenSession,
  type DayReopenPorts, type DayReopenSession, type DayReopenData, type LockedDayView,
  type DayReopenPort, type ReopenResult,
} from './day-reopen-session';
import {
  createStockHealthSession,
  type StockHealthPorts, type StockHealthSession, type StockHealthData,
} from './inventory-health-session';
import {
  createStoredValueOversightSession,
  type StoredValueOversightPorts, type StoredValueOversightSession, type StoredValueOversightData,
  type DoubleSpendView, type VelocityFlagView, type LiabilityReconciliationView,
} from './stored-value-session';
import {
  createIntegrationHealthSession,
  type IntegrationHealthPorts, type IntegrationHealthSession, type IntegrationHealthData,
  type AdapterHealthView, type AdapterHealthState,
} from './integration-health-session';
import {
  createGoodsReceiptSession,
  type GoodsReceiptPorts, type GoodsReceiptSession, type GoodsReceiptData, type GrnRecordView, type GrnDiscrepancyView,
} from './goods-receipt-session';
import {
  createDataIoSession,
  type DataIoPorts, type DataIoSession, type ExportDomainView, type ExportAuditView,
  type ExportResult, type ValidateResult, type CommitResult, type ImportPreviewView,
} from './data-io-session';
import {
  createWorkforceInboxSession,
  type WorkforceInboxPorts, type WorkforceInboxSession, type WorkforceWorklistData,
  type WorkforceDismissPort,
} from './workforce-inbox-session';
import {
  createFleetSession, type FleetPorts, type FleetSession, type FleetDeviceRow, type FleetSummaryRollup,
} from './fleet-session';
import type { DeviceChangeCommand } from './fleet-device-command';
import { deviceChangeRequest, type FleetDeliveryPort } from './fleet-device-delivery';
import {
  createProductPublishReviewSession, type ProductPublishReviewPorts, type ProductPublishReviewSession,
} from './product-publish-review-session';
import { deliverOnePublish, type PublishDeliveryPort, type PublishHttp } from './product-publish-delivery';
import type { ProductPublishPayload, ProductPublishBarcode } from './catalogue-publish-command';
import type { CategoryPolicy } from '../../../packages/product/src/index';
import {
  foldPayRun, buildPayslip, resolveStatutoryParams, DEFAULT_STATUTORY_SCHEDULE,
  type PayRunAggregate, type PayrollTotals, type SettlementInput as PayrollSettlementInput,
  type Payslip as PayrollPayslip, type Settlement as PayrollSettlement,
} from '../../../packages/payroll/src/index';
import type { LedgerSide, QueuedPosting } from '../../../packages/period-close/src/index';
import { createAdminSession, type AdminPorts, type AdminSession } from './admin-session';
import { createSetupSession, type SetupSession } from './setup-session';
import {
  SetupEditController, editorFor, parseDraft, saveResultFromError, type SaveResult,
} from './setup-editing';
import type { SetupStatus } from '../../../packages/tenant/src/index';
import type { Device, SupportSession, VersionPolicy } from '../../../packages/platform-admin/src/index';
import {
  createAiSession, type AiPorts, type AiSession, type PendingProposal,
} from './ai-session';
import type { AgentBudget, KillSwitch, UsageEntry } from '../../../packages/ai/src/index';
import {
  createMigrationSession, type MigrationPorts, type MigrationSession,
} from './migration-session';
import type {
  ControlTotal, HistoryExclusion, LegacyArchive, LegacySource, MigrationException,
  ParallelDayResult, ParallelDifference, TeamMember,
} from '../../../packages/migration/src/index';
// From the specific module, not the `@sre/identity` barrel (which re-exports node:crypto-using engines that
// break the browser bundle). Type-only here, but kept off the barrel for consistency with admin-session.
import type { UserAccount } from '../../../packages/identity/src/account';
import type { AuditRecord, LegalHold, RetentionPolicy } from '../../../packages/audit/src/index';
import type { Producer } from '../../../packages/reporting/src/index';

/** What the store knows about a product this screen may be asked to count. */
export interface ProductFact {
  readonly id: string;
  /** Value of one smallest unit, in minor units. Without it a count cannot be valued. */
  readonly valuePerUnitMinor: number;
}

/** The last-synced payload the ERP server injects before boot. Absent = this screen knows nothing. */
export interface ManagerData {
  readonly approvals?: readonly ApprovalRequest[];
  readonly openExceptions?: readonly RegisterItem[];
  readonly unsentItems?: readonly RegisterItem[];
  readonly tasks?: readonly RegisterItem[];
  readonly products?: readonly ProductFact[];
}

/** What the buyer's screen was last told. Absent means this box knows nothing about buying. */
export interface BuyingData {
  readonly buyerId?: string;
  /** Who may check this buyer's work. The box has already removed the buyer from it (§28). */
  readonly approvers?: readonly string[];
  readonly productIds?: readonly string[];
  /** Per-tenant tolerances for the three-way match. */
  readonly quantityToleranceBps?: number;
  readonly priceToleranceBps?: number;
  readonly immaterialMinor?: number;
  /** What each purchase order ordered, keyed by PO number. */
  readonly ordered?: Readonly<Record<string, readonly { readonly productId: string; readonly qty: number; readonly unitMinor: number }[]>>;
  /** What was received against each purchase order. */
  readonly received?: Readonly<Record<string, readonly { readonly productId: string; readonly qty: number }[]>>;
  /** Invoices already captured, keyed by invoice number. */
  readonly captured?: Readonly<Record<string, readonly InvoiceLine[]>>;
}

/** What the product-and-pricing screen was last told. Absent means this box knows nothing of it. */
export interface CatalogueData {
  readonly userId?: string;
  readonly storeId?: string;
  /** Today in the shop's own calendar. The screen never reads a clock of its own. */
  readonly today?: string;
  /** Minimum gross margin in basis points. Per-tenant policy (M05-FR-02). */
  readonly marginFloorBps?: number;
  /** Who may approve a below-floor price or a margin-losing offer. Never the person setting it. */
  readonly approvers?: readonly string[];
  /** The tenant's own department hierarchy — what each department requires is theirs to say. */
  readonly categories?: readonly Category[];
  readonly products?: readonly ProductRecord[];
  /** Every price entry ever recorded, any status. */
  readonly priceEntries?: readonly PriceEntry[];
  /** What one unit cost us, in minor units, keyed by product. A gap here is a real gap. */
  readonly costsMinor?: Readonly<Record<string, number>>;
  readonly barcodes?: readonly { readonly barcode: string; readonly productId: string }[];
  readonly promotions?: readonly Promotion[];
  /** The shop's shelf addresses (M04-FR-02). Absent means nobody has addressed the shelves yet. */
  readonly shelfLocations?: readonly ShelfLocation[];
  readonly shelfAssignments?: readonly ShelfAssignment[];
  /** Which zones this store collects last. Absent means it has not said, and the screen says so. */
  readonly zoneOrder?: readonly string[];
}

/** What the merchandising screen was last told. Absent means this box knows nothing of it. */
export interface MerchandisingData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly today?: string;
  readonly now?: string;
  /** Fill level below which a facing is worth refilling, in bp. Per-tenant. */
  readonly refillAtBp?: number;
  /** How old a count may be before acting on it wastes a walk. Per-tenant. */
  readonly countStaleAfterMinutes?: number;
  readonly refillRole?: string;
  readonly shelfLocations?: readonly ShelfLocation[];
  readonly shelfAssignments?: readonly ShelfAssignment[];
  readonly planogram?: Planogram | null;
  /** Every count ever taken. Append-only — a recount is a new observation. */
  readonly shelfCounts?: readonly ShelfCount[];
  readonly backstock?: Readonly<Record<string, number>>;
  readonly assortment?: readonly AssortmentEntry[];
  readonly soldProductIds?: readonly string[];
  readonly onHand?: Readonly<Record<string, number>>;
  readonly spaceAreas?: readonly SpaceArea[];
  readonly salesByAreaMinor?: Readonly<Record<string, number>>;
  readonly marginByAreaMinor?: Readonly<Record<string, number>>;
  readonly displayContracts?: readonly DisplayContract[];
  readonly fundingReceivedMinor?: Readonly<Record<string, number>>;
  readonly stillOccupying?: readonly string[];
}

/** What the reporting screen was last told. Absent means this box knows nothing of it. */
export interface ReportingData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly branchId?: string | null;
  readonly now?: string;
  readonly laggingAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
  /**
   * What this shop actually records today.
   *
   * The gaps are the point: everything absent from this list makes its reports **refuse**, by name,
   * rather than run and come back as zero.
   */
  readonly records?: readonly Producer[];
  readonly sales?: readonly ReportableSale[];
  readonly lastSyncedAt?: string | null;
  readonly unsentCount?: number;
  readonly exceptions?: readonly { readonly what: string }[];
  /** False means nobody set the shop's limits, so nothing was checked — not that nothing is wrong. */
  readonly exceptionRulesKnown?: boolean;
  /** The shop's own roles and who holds them, so the export runs the SAME default-deny check. */
  readonly roles?: readonly Role[];
  readonly roleAssignments?: readonly RoleAssignment[];
  /** The trading day these figures are for, as the shop reckons it — not the calendar date. */
  readonly tradingDay?: string;
  /** One row per trading day this box holds, most recent first (M29-FR-02). */
  readonly dayTotals?: readonly DayTotal[];
  /** Units sold today per department. Units rather than money — the log records no money per line. */
  readonly unitsByCategory?: Readonly<Record<string, number>>;
  readonly unitsWithNoCategory?: number;
  readonly categoryNames?: Readonly<Record<string, string>>;
}

/**
 * What the box tells the service desk.
 *
 * `sales` is **every bill this box holds**, not the trading day's: a customer brings back a receipt
 * from last Tuesday, and that is the ordinary case this screen exists for.
 */
export interface ServiceData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly branchId?: string | null;
  readonly now?: string;
  readonly tradingDay?: string;
  readonly returnWindowDays?: number;
  readonly approvalThresholdMinor?: number;
  readonly noReceiptCapMinor?: number;
  readonly agentAuthorityMinor?: number;
  readonly compensationCapMinor?: number;
  readonly sales?: readonly OriginalSale[];
  /** Returns the CLOUD knows about — merged with this box's own, never replaced by them. */
  readonly returnHistory?: readonly RecordedReturn[];
  readonly cases?: readonly ServiceCase[];
  readonly satisfaction?: readonly SatisfactionScore[];
  readonly slaPolicy?: SlaPolicy;
}

/**
 * The desk's ports.
 *
 * `slaPolicy` is deliberately NOT defaulted to an empty object: an empty policy and no policy read
 * the same to a lookup, and the desk has to be able to say out loud that the times it is showing
 * are the software's starting figures rather than anything this shop agreed.
 */
export function servicePortsFromData(
  data: ServiceData | undefined,
  local: { readonly returns: readonly RecordedReturn[]; readonly stockLedger: Ledger; readonly outbox: SyncOutbox },
): ServicePorts {
  return {
    sales: () => data?.sales ?? [],
    // Both sources, merged. The cloud alone leaves the at-most-once guard blind exactly when the
    // line is down, which is when a shop is least supervised; the box alone cannot see a return
    // taken at another branch. `returnRegister` counts a shared return id once.
    returns: () => [...(data?.returnHistory ?? []), ...local.returns],
    refunds: () => [...(data?.returnHistory ?? []), ...local.returns]
      .map((r) => ({
        returnId: r.returnId,
        originalSaleId: r.originalSaleId,
        refundMinor: (r as { refundMinor?: number }).refundMinor ?? 0,
      })),
    cases: () => data?.cases ?? [],
    slaPolicy: () => data?.slaPolicy,
    satisfaction: () => data?.satisfaction ?? [],
    stockLedger: () => local.stockLedger,
    outbox: () => local.outbox,
  };
}

/** Build the service desk, or `null` when this box was told nothing about the desk's limits. */
export function bootService(
  data: ServiceData | undefined,
  local?: { readonly returns: readonly RecordedReturn[]; readonly stockLedger: Ledger; readonly outbox: SyncOutbox },
): ServiceSession | null {
  if (data === undefined) return null;
  const wired = local ?? {
    returns: [],
    stockLedger: new Ledger(new InMemoryLedgerStore()),
    outbox: new SyncOutbox(),
  };
  return createServiceSession(
    {
      tenantId: 'tenant',
      storeId: data.storeId ?? 'store-1',
      laneId: 'service-desk',
      // NOT defaulted. A refund and a compensation both carry the name of whoever gave them into
      // an audit record that is the only evidence afterwards.
      userId: data.userId === undefined ? null : data.userId,
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      tradingDay: data.tradingDay ?? '',
      returnWindowDays: data.returnWindowDays ?? 0,
      approvalThresholdMinor: data.approvalThresholdMinor ?? 0,
      noReceiptCapMinor: data.noReceiptCapMinor ?? 0,
      agentAuthorityMinor: data.agentAuthorityMinor ?? 0,
      compensationCapMinor: data.compensationCapMinor ?? 0,
    },
    servicePortsFromData(data, wired),
  );
}

/** What the box tells the expiry and recall screen. */
export interface ExpiryData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly now?: string;
  readonly nearExpiryDays?: number;
  /**
   * Every batch with its expiry. **Absent means this shop does not record batch dates at all**,
   * which is a different thing from nothing going out of date — and only one of those is good news.
   */
  readonly batches?: readonly Batch[];
  readonly recalls?: readonly RecallRecord[];
  readonly productNames?: Readonly<Record<string, string>>;
}

export function expiryPortsFromData(
  data: ExpiryData | undefined,
  ledger: Ledger,
  recallCloud: RecallCloudPort,
): ExpiryPorts {
  return {
    batches: () => data?.batches ?? [],
    ledger: () => ledger,
    recalls: () => data?.recalls ?? [],
    // NOT defaulted to `{}`. An empty name map and no name map read the same to a lookup, and the
    // screen needs to fall back to the product code rather than showing a blank where a food
    // product's name belongs.
    productNames: () => data?.productNames,
    recallCloud,
  };
}

/**
 * Build the expiry and recall screen, or `null` when the box was told no near-expiry window.
 *
 * The recall write-path defaults to the real same-origin port, so a boxed screen records recalls at
 * head office out of the box; a test or the offline path can inject its own.
 */
export function bootExpiry(
  data: ExpiryData | undefined,
  ledger?: Ledger,
  recallCloud: RecallCloudPort = openRecallCloudPort(),
): ExpirySession | null {
  if (data === undefined) return null;
  return createExpirySession(
    {
      tenantId: 'tenant',
      storeId: data.storeId ?? 'store-1',
      // NOT defaulted. A recall carries the name of whoever started it.
      userId: data.userId === undefined ? null : data.userId,
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      nearExpiryDays: data.nearExpiryDays ?? 0,
    },
    expiryPortsFromData(data, ledger ?? new Ledger(new InMemoryLedgerStore()), recallCloud),
  );
}

/** What the box tells the finance screen. */
export interface FinanceData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly now?: string;
  readonly period?: string;
  readonly tradingDayCutoff?: string;
  readonly journalPrefixes?: { readonly takings: string; readonly tax: string; readonly refunds: string };
  /** What the shop's own record says it took. **Absent means nothing to compare against.** */
  readonly ledger?: LedgerSide;
  readonly postings?: readonly QueuedPosting[];
  readonly periodState?: { readonly closed: boolean; readonly closedBy?: string; readonly closedAt?: string };
  readonly unsentSyncCount?: number;
  readonly openExceptionCount?: number;
}

export function financePortsFromData(data: FinanceData | undefined): FinancePorts {
  return {
    // NOT defaulted to a zeroed ledger. A ledger of noughts would disagree with the accounts by
    // the whole month and read as a reconciliation failure, when the truth is that nobody has
    // told this screen what the shop took.
    ledger: () => data?.ledger,
    postings: () => data?.postings ?? [],
    periodState: () => data?.periodState ?? { closed: false },
    unsentSyncCount: () => data?.unsentSyncCount ?? 0,
    openExceptionCount: () => data?.openExceptionCount ?? 0,
  };
}

/** Build the finance screen, or `null` when the box was told no chart-of-accounts headings. */
export function bootFinance(data: FinanceData | undefined): FinanceSession | null {
  if (data === undefined) return null;
  return createFinanceSession(
    {
      tenantId: 'tenant',
      period: data.period ?? '',
      // NOT defaulted. A month close carries the name of whoever closed it.
      userId: data.userId === undefined ? null : data.userId,
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      tradingDayCutoff: data.tradingDayCutoff ?? '00:00',
      journalPrefixes: data.journalPrefixes ?? { takings: '', tax: '', refunds: '' },
    },
    financePortsFromData(data),
  );
}

/** What the box tells the GST reconciliation screen — the last-synced queue plus who is looking. */
export interface GstReconciliationData {
  readonly userId?: string;
  /** The queue snapshot (both documents), folded from the item-2 registers. */
  readonly rows?: readonly GstQueueRow[];
  /** The permission codes this user holds — the menu and the actions are gated the same way the server is. */
  readonly permissions?: readonly string[];
}

const GST_READ_PERMISSION = 'finance.einvoice.read';
const GST_ACT_PERMISSION = 'finance.einvoice.generate';

export function gstReconciliationPortsFromData(
  data: GstReconciliationData | undefined,
  outbox: SyncOutbox = new SyncOutbox(),
): GstReconciliationPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    rows: () => data?.rows ?? [],
    // Default-deny: an absent permission list can read nothing (the server would refuse it anyway).
    mayRead: () => held.has(GST_READ_PERMISSION),
    mayAct: () => held.has(GST_ACT_PERMISSION),
    outbox: () => outbox,
  };
}

/** Build the GST reconciliation screen, or `null` when the box carried no payload for it. */
export function bootGstReconciliation(
  data: GstReconciliationData | undefined,
  outbox: SyncOutbox = new SyncOutbox(),
): GstReconciliationSession | null {
  if (data === undefined) return null;
  return createGstReconciliationSession(
    { userId: data.userId === undefined ? null : data.userId },
    gstReconciliationPortsFromData(data, outbox),
  );
}

/** The last storage problem the GST outbox hit, so the shell can show it — never a silent failure (P-08). */
export let gstReconciliationStorageProblem: string | undefined;

/**
 * Open the device-backed outbox the GST reconciliation screen queues portal actions to. It restores whatever
 * is already saved (so an unsynced request survives a reload) and keeps writing itself back on every change.
 * Where the device offers no usable storage it degrades to in-memory and records why — the request still
 * queues and still syncs, it just will not survive a restart, and that fact is made visible rather than hidden.
 */
function openGstReconciliationOutbox(): SyncOutbox {
  const storage = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
  const onProblem = (why: string): void => { gstReconciliationStorageProblem = why; };
  return openDeviceOutbox(guardedStore('sre.gst-portal-outbox', storage, onProblem), onProblem);
}

/** What the box tells the category-rules screen — the categories, their dated policies, and who is looking. */
export interface CategoryPolicyData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  /** The store's trading day the policies are resolved on. */
  readonly onDate?: string;
  readonly categories?: readonly CategoryPolicy[];
}

const CATEGORY_POLICY_PERMISSION = 'catalogue.pack.read';

export function categoryPolicyPortsFromData(data: CategoryPolicyData | undefined): CategoryPolicyPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    mayRead: () => held.has(CATEGORY_POLICY_PERMISSION),
    categories: () => data?.categories ?? [],
    onDate: data?.onDate ?? '1970-01-01',
  };
}

/** Build the category-rules screen, or `null` when the box carried no payload for it. */
export function bootCategoryPolicy(data: CategoryPolicyData | undefined): CategoryPolicySession | null {
  if (data === undefined) return null;
  return createCategoryPolicySession(
    { userId: data.userId === undefined ? null : data.userId },
    categoryPolicyPortsFromData(data),
  );
}

/** What the box tells the employee self-service (ESS) screen — who is looking and what they hold. The rota and
 *  payslip themselves come LIVE from the two self-scoped reads, not the pack. */
export interface EssData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

const ESS_PERMISSION = 'payroll.ess.self';

export function essPortsFromData(data: EssData | undefined, roster: EssRoster | null, payslip: EssPayslip | null): EssPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    mayRead: () => held.has(ESS_PERMISSION),
    roster: () => roster,
    payslip: () => payslip,
  };
}

/** Build the ESS screen, or `null` when the box carried no payload for it. First paint has no live data yet. */
export function bootEss(data: EssData | undefined): EssSession | null {
  if (data === undefined) return null;
  return createEssSession(
    { userId: data.userId === undefined ? null : data.userId },
    essPortsFromData(data, null, null),
  );
}

/** Read my own rota (a self-scoped GET). Null offline/refused so the shell keeps what it was showing. */
export async function fetchMyRoster(): Promise<EssRoster | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null; // off-browser (tests inject their own http)
  try {
    const res = await fetchFn('/v1/hr/workforce/my-roster', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) return null;
    const b = (await res.json()) as { known?: boolean; active?: boolean; shifts?: EssRoster['shifts'] };
    return { known: b.known ?? false, active: b.active ?? false, shifts: b.shifts ?? [] };
  } catch {
    return null;
  }
}

/** Read my own latest payslip (a self-scoped GET, already redacted server-side). Null offline/refused. */
export async function fetchMyPayslip(): Promise<EssPayslip | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/hr/payroll/my-payslip', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) return null;
    const b = (await res.json()) as {
      issued?: boolean; period?: string;
      view?: { netPayMinor?: number; deductions?: readonly { label: string; amountMinor: number }[]; employerContributions?: { totalMinor?: number } };
    };
    if (b.issued !== true || b.view === undefined) return { issued: false };
    return {
      issued: true,
      ...(b.period !== undefined ? { period: b.period } : {}),
      ...(b.view.netPayMinor !== undefined ? { netPayMinor: b.view.netPayMinor } : {}),
      ...(b.view.deductions !== undefined ? { deductions: b.view.deductions } : {}),
      ...(b.view.employerContributions?.totalMinor !== undefined ? { employerTotalMinor: b.view.employerContributions.totalMinor } : {}),
    };
  } catch {
    return null;
  }
}

/** What the box tells the GST-returns screen — the last-synced filing queue plus who is looking. */
export interface GstReturnsData {
  readonly userId?: string;
  /** Every filing period folded to its current submission state (from the item-1 submission store). */
  readonly rows?: readonly GstReturnRow[];
  /** The permission codes this user holds — the menu and the screen are gated the same way the server is. */
  readonly permissions?: readonly string[];
}

const GST_RETURNS_READ_PERMISSION = 'finance.gstr.read';
const GST_RETURNS_APPROVE_PERMISSION = 'finance.gstr.approve';
const GST_RETURNS_SUBMIT_PERMISSION = 'finance.gstr.submit';

export function gstReturnsPortsFromData(
  data: GstReturnsData | undefined,
  outbox: SyncOutbox = new SyncOutbox(),
): GstReturnsPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    rows: () => data?.rows ?? [],
    // Default-deny: an absent permission list can read/act on nothing (the server would refuse it anyway).
    mayRead: () => held.has(GST_RETURNS_READ_PERMISSION),
    mayApprove: () => held.has(GST_RETURNS_APPROVE_PERMISSION),
    maySubmit: () => held.has(GST_RETURNS_SUBMIT_PERMISSION),
    outbox: () => outbox,
  };
}

/** Build the GST-returns screen, or `null` when the box carried no payload for it. */
export function bootGstReturns(
  data: GstReturnsData | undefined,
  outbox: SyncOutbox = new SyncOutbox(),
): GstReturnsSession | null {
  if (data === undefined) return null;
  return createGstReturnsSession(
    { userId: data.userId === undefined ? null : data.userId },
    gstReturnsPortsFromData(data, outbox),
  );
}

/** What the box tells the waste review screen — the last-synced losses plus who is looking. */
export interface WasteData {
  readonly userId?: string;
  /** The recorded write-offs, each folded to a review row. */
  readonly rows?: readonly WriteOffRow[];
  /** The permission codes this user holds — the menu and the screen are gated the same way the server is. */
  readonly permissions?: readonly string[];
}

const WASTE_READ_PERMISSION = 'waste.view';

export function wastePortsFromData(data: WasteData | undefined): WasteReviewPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    rows: () => data?.rows ?? [],
    // Default-deny: an absent permission list can read nothing (the server would refuse it anyway).
    mayRead: () => held.has(WASTE_READ_PERMISSION),
  };
}

/** Build the waste review screen, or `null` when the box carried no payload for it. */
export function bootWaste(data: WasteData | undefined): WasteReviewSession | null {
  if (data === undefined) return null;
  return createWasteReviewSession(
    { userId: data.userId === undefined ? null : data.userId },
    wastePortsFromData(data),
  );
}

/** What the box tells the shop-floor write-off CAPTURE screen (M28-FR-01 · §28): who is looking, what they
 *  hold, and the tenant's material-loss threshold. Absent means the box carried no payload for it, and the
 *  shell shows its clearly-marked sample stand-in. */
export interface WriteOffCaptureData {
  readonly userId?: string;
  /** The permission codes this user holds — `inventory.movement.append` to record a loss. Never defaulted. */
  readonly permissions?: readonly string[];
  /** The tenant's material-loss threshold in paise. Absent → the engine default (the same line the server
   *  enforces), never a fabricated number presented as the shop's. */
  readonly materialThresholdMinor?: number;
}

const WRITE_OFF_APPEND_PERMISSION = 'inventory.movement.append';
/** Off-browser / tests inject their own http; a real port is wired in the boot body. */
const NOOP_CAPTURE_PORT: WriteOffCapturePort = { post: async () => 'lost_link' };

export function writeOffCapturePortsFromData(
  data: WriteOffCaptureData | undefined,
  capturePort: WriteOffCapturePort = NOOP_CAPTURE_PORT,
): WriteOffCapturePorts {
  const held = new Set(data?.permissions ?? []);
  return {
    // Default-deny: an absent permission list can record nothing (the server would refuse it anyway).
    mayCapture: () => held.has(WRITE_OFF_APPEND_PERMISSION),
    capturePort: () => capturePort,
  };
}

/** Build the write-off capture screen, or `null` when the box carried no payload for it (shell shows the
 *  sample). The threshold is the injected tenant policy; absent, the engine default is used — the SAME line the
 *  server enforces, never invented here. */
export function bootWriteOffCapture(
  data: WriteOffCaptureData | undefined,
  capturePort?: WriteOffCapturePort,
): WriteOffCaptureSession | null {
  if (data === undefined) return null;
  return createWriteOffCaptureSession(
    {
      userId: data.userId === undefined ? null : data.userId,
      materialThresholdMinor: data.materialThresholdMinor ?? DEFAULT_WRITE_OFF_THRESHOLD_MINOR,
    },
    writeOffCapturePortsFromData(data, capturePort),
  );
}

/** The authenticated POST of a stock write-off — the raiser's OWN session cookie (`credentials: 'same-origin'`),
 *  never a service token. The server records the loss in the caller's own name and enforces the threshold,
 *  evidence and §28 separate-approver rules; the screen never fabricates an approver or an evidence reference.
 *  A network/timeout is a retryable lost link, not a refusal. The writeOffId rides in the URL (idempotency —
 *  a re-send under the same id records once). No AI calls this — a person does (hard rule #5). */
function openWriteOffCapturePort(): WriteOffCapturePort {
  return {
    post: async (input): Promise<CaptureResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const { writeOffId, ...body } = input;
      try {
        const res = await fetchFn(`/v1/inventory/write-off/${encodeURIComponent(writeOffId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': writeOffId, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        if (res.status === 201) return 'recorded';
        if (res.status === 409) return 'conflict';
        if (res.status === 422) {
          const code = await readErrorCode(res);
          if (code === 'write_off_needs_evidence') return 'needs_evidence';
          if (code === 'write_off_needs_approval') return 'needs_approval';
          if (code === 'approver_may_not_approve') return 'approver_not_authorised';
          return 'refused';
        }
        if (res.status === 400) return 'refused';
        return 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the `code` from a governed-route error body, tolerantly — a body that does not parse maps to a plain
 *  refusal rather than throwing (the screen still shows the operator an honest outcome). */
async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code;
  } catch {
    return undefined;
  }
}

/** What the box tells the stock-count review screen — the last-synced reconciled counts plus who is looking. */
export interface CountsData {
  readonly userId?: string;
  /** The reconciled blind counts, each folded to a review row. */
  readonly rows?: readonly CountRow[];
  /** The permission codes this user holds — `count.view` to review counts. Never defaulted. */
  readonly permissions?: readonly string[];
}

const COUNTS_READ_PERMISSION = 'count.view';

export function countsPortsFromData(data: CountsData | undefined): CountsReviewPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    rows: () => data?.rows ?? [],
    mayRead: () => held.has(COUNTS_READ_PERMISSION),
  };
}

/** Build the stock-count review screen, or `null` when the box carried no payload for it. */
export function bootCounts(data: CountsData | undefined): CountsReviewSession | null {
  if (data === undefined) return null;
  return createCountsReviewSession(
    { userId: data.userId === undefined ? null : data.userId },
    countsPortsFromData(data),
  );
}

/** What the box tells the Data Quality inbox screen: who is looking, what they may do, and (optionally) the
 *  worklist it last carried. The worklist is a LIVE cloud read (`GET /v1/ai/data-quality/worklist`) refreshed
 *  by the shell when online; offline the screen shows its clearly-marked sample stand-in. */
export interface DataQualityInboxData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: DataQualityWorklistData;
}

const DATA_QUALITY_READ_PERMISSION = 'ai.proposal.read';
const DATA_QUALITY_DISMISS_PERMISSION = 'ai.suggestion.dismiss';
/** Nothing to show until the live read succeeds — and the agent-off note carries the reason. */
const INACTIVE_WORKLIST: DataQualityWorklistData = Object.freeze({ agentActive: false, open: [], dismissed: [] });
/** Off-browser / tests inject their own http; a real port is wired in the boot body. */
const NOOP_DISMISS_PORT: DataQualityDismissPort = { post: async () => 'lost_link' };

export function dataQualityInboxPortsFromData(
  data: DataQualityInboxData | undefined,
  worklist?: DataQualityWorklistData,
  dismissPort: DataQualityDismissPort = NOOP_DISMISS_PORT,
): DataQualityInboxPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? INACTIVE_WORKLIST,
    // Default-deny: an absent permission list can read/dismiss nothing (the server would refuse it anyway).
    mayRead: () => held.has(DATA_QUALITY_READ_PERMISSION),
    mayDismiss: () => held.has(DATA_QUALITY_DISMISS_PERMISSION),
    dismissPort: () => dismissPort,
  };
}

/** Build the Data Quality inbox, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootDataQualityInbox(
  data: DataQualityInboxData | undefined,
  worklist?: DataQualityWorklistData,
  dismissPort?: DataQualityDismissPort,
): DataQualityInboxSession | null {
  if (data === undefined) return null;
  return createDataQualityInboxSession(
    { userId: data.userId === undefined ? null : data.userId },
    dataQualityInboxPortsFromData(data, worklist, dismissPort),
  );
}

/** The authenticated POST of a steward's dismiss/reopen decision — the operator's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The AI never calls this — a person does. */
function openDataQualityDismissPort(): DataQualityDismissPort {
  return {
    post: async ({ findingId, dismissed, reason }): Promise<DismissOutcome> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `dq-dismiss-${findingId}-${String(dismissed)}`;
      const body = dismissed ? { findingId, reason } : { findingId, reopen: true };
      try {
        const res = await fetchFn('/v1/ai/data-quality/dismissals', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        return res.status >= 200 && res.status < 300 ? 'recorded' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live worklist (a GET — read-only, commits nothing). Returns null offline/refused so the shell
 *  keeps whatever it was showing and its stale strip says the page is what the box last told it. */
export async function fetchDataQualityWorklist(): Promise<DataQualityWorklistData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null; // off-browser (tests inject their own http)
  try {
    const res = await fetchFn('/v1/ai/data-quality/worklist', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    return (await res.json()) as DataQualityWorklistData;
  } catch {
    return null;
  }
}

// ── Operations inbox (A06) — the exact mirror of the Data Quality inbox above ──────────────────────────────

/** What the box tells the Operations inbox screen: who is looking, what they may do, and (optionally) the
 *  worklist it last carried. The worklist is a LIVE cloud read (`GET /v1/ai/operations/worklist`) refreshed by
 *  the shell when online; offline the screen shows its clearly-marked sample stand-in. */
export interface OperationsInboxData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: OperationsWorklistData;
}

const OPERATIONS_READ_PERMISSION = 'ai.proposal.read';
const OPERATIONS_DISMISS_PERMISSION = 'ai.suggestion.dismiss';
const INACTIVE_OPERATIONS_WORKLIST: OperationsWorklistData = Object.freeze({ agentActive: false, open: [], dismissed: [] });
const NOOP_OPERATIONS_DISMISS_PORT: OperationsDismissPort = { post: async () => 'lost_link' };

export function operationsInboxPortsFromData(
  data: OperationsInboxData | undefined,
  worklist?: OperationsWorklistData,
  dismissPort: OperationsDismissPort = NOOP_OPERATIONS_DISMISS_PORT,
): OperationsInboxPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? INACTIVE_OPERATIONS_WORKLIST,
    // Default-deny: an absent permission list can read/dismiss nothing (the server would refuse it anyway).
    mayRead: () => held.has(OPERATIONS_READ_PERMISSION),
    mayDismiss: () => held.has(OPERATIONS_DISMISS_PERMISSION),
    dismissPort: () => dismissPort,
  };
}

/** Build the Operations inbox, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootOperationsInbox(
  data: OperationsInboxData | undefined,
  worklist?: OperationsWorklistData,
  dismissPort?: OperationsDismissPort,
): OperationsInboxSession | null {
  if (data === undefined) return null;
  return createOperationsInboxSession(
    { userId: data.userId === undefined ? null : data.userId },
    operationsInboxPortsFromData(data, worklist, dismissPort),
  );
}

/** The authenticated POST of an operator's set-aside/reopen decision — the operator's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The AI never calls this — a person does. */
function openOperationsDismissPort(): OperationsDismissPort {
  return {
    post: async ({ findingId, dismissed, reason }): Promise<DismissOutcome> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `ops-dismiss-${findingId}-${String(dismissed)}`;
      const body = dismissed ? { findingId, reason } : { findingId, reopen: true };
      try {
        const res = await fetchFn('/v1/ai/operations/dismissals', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        return res.status >= 200 && res.status < 300 ? 'recorded' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live worklist (a GET — read-only, commits nothing). Returns null offline/refused so the shell
 *  keeps whatever it was showing and its stale strip says the page is what the box last told it. */
export async function fetchOperationsWorklist(): Promise<OperationsWorklistData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null; // off-browser (tests inject their own http)
  try {
    const res = await fetchFn('/v1/ai/operations/worklist', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    return (await res.json()) as OperationsWorklistData;
  } catch {
    return null;
  }
}

// ── Loss-prevention investigations inbox (M15) — the manager's open-cases screen ────────────────────────────

/** What the box tells the loss-prevention inbox screen: who is looking, what they may do, and (optionally) the
 *  worklist it last carried. The open cases are a LIVE cloud read (`GET /v1/loss-prevention/cases`) refreshed by
 *  the shell when online; offline the screen shows its clearly-marked sample stand-in. */
export interface LossPreventionInboxData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: LpWorklistData;
}

const LP_READ_PERMISSION = 'lp.case.read';
const LP_MANAGE_PERMISSION = 'lp.case.manage';
const EMPTY_LP_WORKLIST: LpWorklistData = Object.freeze({ openCount: 0, totalValueMinor: 0, cases: [] });
const NOOP_LP_CLOSE_PORT: LpCloseCasePort = { post: async () => 'lost_link' };

export function lpInboxPortsFromData(
  data: LossPreventionInboxData | undefined,
  worklist?: LpWorklistData,
  closePort: LpCloseCasePort = NOOP_LP_CLOSE_PORT,
): LpInboxPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_LP_WORKLIST,
    // Default-deny: an absent permission list can read/close nothing (the server would refuse it anyway).
    mayRead: () => held.has(LP_READ_PERMISSION),
    mayManage: () => held.has(LP_MANAGE_PERMISSION),
    closePort: () => closePort,
  };
}

/** Build the loss-prevention inbox, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootLpInbox(
  data: LossPreventionInboxData | undefined,
  worklist?: LpWorklistData,
  closePort?: LpCloseCasePort,
): LpInboxSession | null {
  if (data === undefined) return null;
  return createLpInboxSession(
    { userId: data.userId === undefined ? null : data.userId },
    lpInboxPortsFromData(data, worklist, closePort),
  );
}

/** The authenticated POST of a manager's close decision — the manager's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The caseId rides in the URL; the
 *  server records the close in the caller's own name and enforces §28/evidence for a "proven" outcome. */
function openLpClosePort(): LpCloseCasePort {
  return {
    post: async ({ caseId, outcome, note }): Promise<CloseResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `lp-close-${caseId}-${outcome}`;
      try {
        const res = await fetchFn(`/v1/loss-prevention/cases/${encodeURIComponent(caseId)}/close`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ outcome, note }),
        });
        return res.status >= 200 && res.status < 300 ? 'closed' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live open-investigations worklist (a GET — read-only). Returns null offline/refused so the shell
 *  keeps whatever it was showing and its stale strip says the page is what the box last told it. */
export async function fetchLpWorklist(): Promise<LpWorklistData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/loss-prevention/cases', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    return (await res.json()) as LpWorklistData;
  } catch {
    return null;
  }
}

// ── Manager rostering screen (M25-FR-01) — the "who is on, what is the roster short" desk ──────────────────

/** What the box tells the rostering screen: who is looking, what they may do, and (optionally) the worklist it
 *  last carried. The gaps and the roster context are a LIVE cloud read (`GET /v1/hr/workforce/roster` +
 *  `/roster-gaps`) refreshed by the shell when online; offline the screen shows its clearly-marked sample
 *  stand-in. */
export interface RosteringScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: RosteringData;
}

const ROSTER_READ_PERMISSION = 'workforce.roster.read';
const ROSTER_MANAGE_PERMISSION = 'workforce.roster.manage';
const EMPTY_ROSTERING: RosteringData = Object.freeze({ gaps: [], employees: [], shifts: [], assignments: [] });
const NOOP_ASSIGN_PORT: AssignPort = { post: async () => 'lost_link' };

export function rosteringPortsFromData(
  data: RosteringScreenData | undefined,
  worklist?: RosteringData,
  assignPort: AssignPort = NOOP_ASSIGN_PORT,
): RosteringPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_ROSTERING,
    // Default-deny: an absent permission list can read/assign nothing (the server would refuse it anyway).
    mayRead: () => held.has(ROSTER_READ_PERMISSION),
    mayManage: () => held.has(ROSTER_MANAGE_PERMISSION),
    assignPort: () => assignPort,
  };
}

/** Build the rostering screen, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootRostering(
  data: RosteringScreenData | undefined,
  worklist?: RosteringData,
  assignPort?: AssignPort,
): RosteringSession | null {
  if (data === undefined) return null;
  return createRosteringSession(
    { userId: data.userId === undefined ? null : data.userId },
    rosteringPortsFromData(data, worklist, assignPort),
  );
}

/** The authenticated POST of a manager's assignment — the manager's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The shift and employee ride in the
 *  URL; the server records the assignment in the caller's own name and re-checks `workforce.roster.manage`. */
function openAssignPort(): AssignPort {
  return {
    post: async ({ shiftId, employeeId, role }): Promise<AssignResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `asg-${shiftId}-${employeeId}-${role}`;
      try {
        const res = await fetchFn(
          `/v1/hr/workforce/shifts/${encodeURIComponent(shiftId)}/assignments/${encodeURIComponent(employeeId)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ role }),
          },
        );
        return res.status >= 200 && res.status < 300 ? 'assigned' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live roster worklist: the stored roster (employees/shifts/assignments) folded with the cloud's
 *  gaps engine. Two GETs (both read-only, `workforce.roster.read`); returns null offline/refused so the shell
 *  keeps whatever it was showing and its stale strip says the page is what the box last told it. */
export async function fetchRosteringWorklist(): Promise<RosteringData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const [rosterRes, gapsRes] = await Promise.all([
      fetchFn('/v1/hr/workforce/roster', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' }),
      fetchFn('/v1/hr/workforce/roster-gaps', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' }),
    ]);
    if (rosterRes.status >= 400 || gapsRes.status >= 400) return null;
    const roster = (await rosterRes.json()) as { employees?: unknown; shifts?: unknown; assignments?: unknown };
    const gapsBody = (await gapsRes.json()) as { gaps?: unknown };
    return {
      gaps: Array.isArray(gapsBody.gaps) ? (gapsBody.gaps as RosteringData['gaps']) : [],
      employees: Array.isArray(roster.employees) ? (roster.employees as RosteringData['employees']) : [],
      shifts: Array.isArray(roster.shifts) ? (roster.shifts as RosteringData['shifts']) : [],
      assignments: Array.isArray(roster.assignments) ? (roster.assignments as RosteringData['assignments']) : [],
    };
  } catch {
    return null;
  }
}

// ── Manager checklist screen (M25-FR-02) — the "did the shift open/close, and what is outstanding" desk ────

/** What the box tells the checklist screen: who is looking, what they may do, and (optionally) the worklist it
 *  last carried. The checklists are a LIVE cloud read (`GET /v1/hr/workforce/checklists`) refreshed by the shell
 *  when online; offline the screen shows its clearly-marked sample stand-in. */
export interface ChecklistScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: ChecklistData;
}

const CHECKLIST_READ_PERMISSION = 'workforce.checklist.read';
const CHECKLIST_MANAGE_PERMISSION = 'workforce.roster.manage';
const EMPTY_CHECKLISTS: ChecklistData = Object.freeze({ checklists: [] });
const NOOP_SUBMIT_CHECKLIST_PORT: SubmitChecklistPort = { post: async () => 'lost_link' };

export function checklistPortsFromData(
  data: ChecklistScreenData | undefined,
  worklist?: ChecklistData,
  submitPort: SubmitChecklistPort = NOOP_SUBMIT_CHECKLIST_PORT,
): ChecklistPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_CHECKLISTS,
    // Default-deny: an absent permission list can read/sign nothing (the server would refuse it anyway).
    mayRead: () => held.has(CHECKLIST_READ_PERMISSION),
    mayManage: () => held.has(CHECKLIST_MANAGE_PERMISSION),
    submitPort: () => submitPort,
  };
}

/** Build the checklist screen, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootChecklist(
  data: ChecklistScreenData | undefined,
  worklist?: ChecklistData,
  submitPort?: SubmitChecklistPort,
): ChecklistSession | null {
  if (data === undefined) return null;
  return createChecklistSession(
    { userId: data.userId === undefined ? null : data.userId },
    checklistPortsFromData(data, worklist, submitPort),
  );
}

/** The authenticated POST of a manager's signed checklist — the manager's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The checklistId rides in the URL; the
 *  server records the checklist in the caller's own name and re-checks `workforce.roster.manage` (and refuses a
 *  blocking item still outstanding). */
function openSubmitChecklistPort(): SubmitChecklistPort {
  return {
    post: async ({ checklistId, kind, items, signedBy, branchId, forDate }): Promise<ChecklistSubmitResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `checklist-${checklistId}-${signedBy}`;
      try {
        const res = await fetchFn(`/v1/hr/workforce/checklists/${encodeURIComponent(checklistId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ kind, items, signedBy, ...(branchId === undefined ? {} : { branchId }), ...(forDate === undefined ? {} : { forDate }) }),
        });
        return res.status >= 200 && res.status < 300 ? 'recorded' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live checklist worklist (a GET — read-only). Returns null offline/refused so the shell keeps
 *  whatever it was showing and its stale strip says the page is what the box last told it. The cloud route hands
 *  back `{ checklists, count, blocked }`; only the checklists are needed (the session recomputes the rest). */
export async function fetchChecklistWorklist(): Promise<ChecklistData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/hr/workforce/checklists', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    const body = (await res.json()) as { checklists?: unknown };
    return { checklists: Array.isArray(body.checklists) ? (body.checklists as readonly StoredChecklist[]) : [] };
  } catch {
    return null;
  }
}

// ── Production quality-release screen (M11-FR-03) — the "which finished batches may go on sale" desk ───────

/** What the box tells the production screen: who is looking, what they may do, and (optionally) the board it
 *  last carried. The runs are a LIVE cloud read (`GET /v1/production/runs`) refreshed by the shell when online;
 *  offline the screen shows its clearly-marked sample stand-in. */
export interface ProductionScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: ProductionData;
}

const PRODUCTION_READ_PERMISSION = 'production.read';
const PRODUCTION_RELEASE_PERMISSION = 'production.release';
const EMPTY_PRODUCTION: ProductionData = Object.freeze({ runs: [] });
const NOOP_RELEASE_PORT: ReleasePort = { post: async () => 'lost_link' };

export function productionPortsFromData(
  data: ProductionScreenData | undefined,
  worklist?: ProductionData,
  releasePort: ReleasePort = NOOP_RELEASE_PORT,
): ProductionPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_PRODUCTION,
    // Default-deny: an absent permission list can read/release nothing (the server would refuse it anyway).
    mayRead: () => held.has(PRODUCTION_READ_PERMISSION),
    mayRelease: () => held.has(PRODUCTION_RELEASE_PERMISSION),
    releasePort: () => releasePort,
  };
}

/** Build the production screen, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootProduction(
  data: ProductionScreenData | undefined,
  worklist?: ProductionData,
  releasePort?: ReleasePort,
): ProductionSession | null {
  if (data === undefined) return null;
  return createProductionSession(
    { userId: data.userId === undefined ? null : data.userId },
    productionPortsFromData(data, worklist, releasePort),
  );
}

/** The authenticated POST of a QC operator's release decision — the operator's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The runId rides in the URL; the server
 *  records the decision in the caller's own name, re-checks `production.release`, and refuses an expired batch.
 *  A 2xx on a pass is a release; a 2xx on a fail is a recorded hold (the batch stays in quarantine). */
function openReleasePort(): ReleasePort {
  return {
    post: async ({ runId, qcPassed, notes }): Promise<ReleaseResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `release-${runId}-${qcPassed ? 'pass' : 'fail'}`;
      try {
        const res = await fetchFn(`/v1/production/runs/${encodeURIComponent(runId)}/release`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ qcPassed, ...(notes === undefined ? {} : { notes }) }),
        });
        if (res.status < 200 || res.status >= 300) return 'refused';
        return qcPassed ? 'released' : 'held';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live production board (a GET — read-only). Returns null offline/refused so the shell keeps whatever
 *  it was showing and its stale strip says the page is what the box last told it. The cloud route hands back
 *  `{ runs, asAt }`; only the runs are needed (the session recomputes the rest). */
export async function fetchProductionBoard(): Promise<ProductionData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/production/runs', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    const body = (await res.json()) as { runs?: unknown };
    return { runs: Array.isArray(body.runs) ? (body.runs as readonly ProductionRun[]) : [] };
  } catch {
    return null;
  }
}

// ── Facilities maintenance & compliance screen (M26-FR-03) — the "what statutory / safety check is overdue" desk ─

/** What the box tells the facilities screen: who is looking, what they may do, and (optionally) the overdue list
 *  it last carried. The overdue tasks are a LIVE cloud read (`GET /v1/facilities/overdue`) refreshed by the shell
 *  when online; offline the screen shows its clearly-marked sample stand-in. */
export interface FacilitiesScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: FacilitiesData;
}

const FACILITIES_READ_PERMISSION = 'facilities.overdue.read';
const FACILITIES_COMPLETE_PERMISSION = 'facilities.task.record';
const EMPTY_FACILITIES: FacilitiesData = Object.freeze({ overdue: [] });
const NOOP_COMPLETE_PORT: CompletePort = { post: async () => 'lost_link' };

export function facilitiesPortsFromData(
  data: FacilitiesScreenData | undefined,
  worklist?: FacilitiesData,
  completePort: CompletePort = NOOP_COMPLETE_PORT,
): FacilitiesPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_FACILITIES,
    // Default-deny: an absent permission list can read/complete nothing (the server would refuse it anyway).
    mayRead: () => held.has(FACILITIES_READ_PERMISSION),
    mayComplete: () => held.has(FACILITIES_COMPLETE_PERMISSION),
    completePort: () => completePort,
  };
}

/** Build the facilities screen, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootFacilities(
  data: FacilitiesScreenData | undefined,
  worklist?: FacilitiesData,
  completePort?: CompletePort,
): FacilitiesSession | null {
  if (data === undefined) return null;
  return createFacilitiesSession(
    { userId: data.userId === undefined ? null : data.userId },
    facilitiesPortsFromData(data, worklist, completePort),
  );
}

/** The authenticated POST of a facilities manager's "it's done" decision — the manager's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The taskId rides in the URL; the server
 *  records the decision in the caller's own name, re-checks `facilities.task.record`, and refuses a completion
 *  with no required evidence or a self-verified safety check (§28). A 2xx is a recorded completion; a 4xx/5xx is
 *  a refusal the screen surfaces rather than fakes (P-08). */
function openCompletePort(): CompletePort {
  return {
    post: async ({ taskId, completedBy, evidenceRefs, verifiedBy, note }): Promise<CompleteResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `complete-${taskId}-${completedBy}`;
      try {
        const res = await fetchFn(`/v1/facilities/tasks/${encodeURIComponent(taskId)}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            completedBy,
            ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
            ...(verifiedBy === undefined ? {} : { verifiedBy }),
            ...(note === undefined ? {} : { note }),
          }),
        });
        if (res.status < 200 || res.status >= 300) return 'refused';
        return 'completed';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live overdue board (a GET — read-only). Returns null offline/refused so the shell keeps whatever it
 *  was showing and its stale strip says the page is what the box last told it. The cloud route hands back
 *  `{ overdue, complianceRisks, asAt }`; only the overdue tasks are needed (the session recomputes the rest).
 *  The route measures lateness against today, so a local YYYY-MM-DD is passed as `?asOf=`. */
export async function fetchFacilitiesBoard(): Promise<FacilitiesData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  const asOf = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetchFn(`/v1/facilities/overdue?asOf=${asOf}`, {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    const body = (await res.json()) as { overdue?: unknown };
    return { overdue: Array.isArray(body.overdue) ? (body.overdue as readonly OverdueTask[]) : [] };
  } catch {
    return null;
  }
}

// ── Refund-exceptions review screen (M13-FR-01/03 · M17) — the governance/loss surface ─────────────────────────

/** What the box tells the refund-exceptions screen: who is looking, what they may do, and (optionally) the
 *  exceptions it last carried. The flagged refunds are a LIVE cloud read
 *  (`GET /v1/pos/return-governance-exceptions`) refreshed by the shell when online; offline the screen shows
 *  its clearly-marked sample stand-in. Read-only — there is no write from this screen. */
export interface ReturnGovernanceData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly exceptions?: ReturnGovernanceExceptions;
}

const RETURN_GOVERNANCE_READ_PERMISSION = 'lp.case.read';
const EMPTY_RETURN_GOVERNANCE: ReturnGovernanceExceptions = Object.freeze({ exceptionCount: 0, totalRefundMinor: 0, exceptions: [] });

export function returnGovernancePortsFromData(
  data: ReturnGovernanceData | undefined,
  exceptions?: ReturnGovernanceExceptions,
): ReturnGovernancePorts {
  const held = new Set(data?.permissions ?? []);
  return {
    exceptions: () => exceptions ?? data?.exceptions ?? EMPTY_RETURN_GOVERNANCE,
    // Default-deny: an absent permission list can read nothing (the server would refuse it anyway).
    mayRead: () => held.has(RETURN_GOVERNANCE_READ_PERMISSION),
  };
}

/** Build the refund-exceptions screen, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootReturnGovernance(
  data: ReturnGovernanceData | undefined,
  exceptions?: ReturnGovernanceExceptions,
): ReturnGovernanceSession | null {
  if (data === undefined) return null;
  return createReturnGovernanceSession(
    { userId: data.userId === undefined ? null : data.userId },
    returnGovernancePortsFromData(data, exceptions),
  );
}

/** Read the live refund exceptions (a GET — read-only). Returns null offline/refused so the shell keeps
 *  whatever it was showing and its stale strip says the page is what the box last told it. The cloud route
 *  hands back `{ count, exceptions }`; the ₹ total is derived here for the summary. */
export async function fetchReturnGovernanceExceptions(): Promise<ReturnGovernanceExceptions | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/pos/return-governance-exceptions', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    const raw = (await res.json()) as { count?: number; exceptions?: ReturnGovernanceExceptions['exceptions'] };
    const exceptions = raw.exceptions ?? [];
    return {
      exceptionCount: raw.count ?? exceptions.length,
      totalRefundMinor: exceptions.reduce((sum, e) => sum + e.refundMinor, 0),
      exceptions,
    };
  } catch {
    return null;
  }
}

// ── Cash-office over/short sign-off (M14-FR-02) ───────────────────────────────────────────────────────────────

/** What the box tells the cash-office over/short screen: who is looking, what they may do, and (optionally) the
 *  worklist it last carried. The open over/shorts are a LIVE cloud read (`GET /v1/shifts/over-short`) refreshed
 *  by the shell when online; offline the screen shows its clearly-marked sample stand-in. */
export interface CashOfficeData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: CashOverShortData;
}

const OVERSHORT_READ_PERMISSION = 'till.shift.read';
const OVERSHORT_REVIEW_PERMISSION = 'till.overshort.review';
const EMPTY_OVERSHORT_WORKLIST: CashOverShortData = Object.freeze({ openCount: 0, totalVarianceMinor: 0, open: [] });
const NOOP_SIGNOFF_PORT: OverShortSignOffPort = { post: async () => 'lost_link' };

export function cashOfficePortsFromData(
  data: CashOfficeData | undefined,
  worklist?: CashOverShortData,
  signOffPort: OverShortSignOffPort = NOOP_SIGNOFF_PORT,
): CashOfficePorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_OVERSHORT_WORKLIST,
    // Default-deny: an absent permission list can read/sign off nothing (the server would refuse it anyway).
    mayRead: () => held.has(OVERSHORT_READ_PERMISSION),
    mayReview: () => held.has(OVERSHORT_REVIEW_PERMISSION),
    signOffPort: () => signOffPort,
  };
}

/** Build the cash-office session, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootCashOffice(
  data: CashOfficeData | undefined,
  worklist?: CashOverShortData,
  signOffPort?: OverShortSignOffPort,
): CashOfficeSession | null {
  if (data === undefined) return null;
  return createCashOfficeSession(
    { userId: data.userId === undefined ? null : data.userId },
    cashOfficePortsFromData(data, worklist, signOffPort),
  );
}

/** The authenticated POST of a reviewer's over/short sign-off — the reviewer's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal. The shiftId rides in the URL; the server records the sign-off in the caller's own name and enforces
 *  §28 (a reviewer may not sign off a drawer they counted). */
function openSignOffPort(): OverShortSignOffPort {
  return {
    post: async ({ shiftId, disposition, note }): Promise<SignOffResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `overshort-review-${shiftId}`;
      try {
        const res = await fetchFn(`/v1/shifts/${encodeURIComponent(shiftId)}/over-short/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ disposition, note }),
        });
        return res.status >= 200 && res.status < 300 ? 'signed' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** One row of the over/short route body (`GET /v1/shifts/over-short`) — the shape the cloud hands back, with the
 *  reviewed rows carrying their sign-off. */
interface RawOverShortRow {
  readonly shiftId: string; readonly tillId: string; readonly cashierId: string; readonly tradingDay: string;
  readonly varianceMinor: number; readonly reasonCode: string | null; readonly reviewed: boolean;
}

/** Read the live over/short worklist (a GET — read-only) and keep only the OPEN (unsigned) rows — the ones the
 *  cash office has to work. Returns null offline/refused so the shell keeps whatever it was showing. */
export async function fetchOverShortWorklist(): Promise<CashOverShortData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/shifts/over-short', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    const body = (await res.json()) as { overShort?: readonly RawOverShortRow[] };
    const open: OverShortView[] = (body.overShort ?? [])
      .filter((r) => !r.reviewed)
      .map((r) => ({
        shiftId: r.shiftId, tillId: r.tillId, cashierId: r.cashierId, tradingDay: r.tradingDay,
        varianceMinor: r.varianceMinor, reasonCode: r.reasonCode,
      }));
    return { openCount: open.length, totalVarianceMinor: open.reduce((s, r) => s + r.varianceMinor, 0), open };
  } catch {
    return null;
  }
}

// ── Day reopen (M14-FR-04 / §28) ──────────────────────────────────────────────────────────────────────────────

/** What the box tells the day-reopen screen: who is looking, what they may do, and (optionally) the worklist it
 *  last carried. The locked days are a LIVE cloud read (`GET /v1/pos/day-close`) the shell refreshes when online;
 *  offline the screen shows its clearly-marked sample stand-in. */
export interface DayReopenScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: DayReopenData;
}

const DAYCLOSE_READ_PERMISSION = 'till.dayclose.read';
const DAYCLOSE_APPROVE_PERMISSION = 'till.dayclose.approve';
const EMPTY_LOCKED_DAYS: DayReopenData = Object.freeze({ lockedCount: 0, locked: [] });
const NOOP_REOPEN_PORT: DayReopenPort = { post: async () => 'lost_link' };

export function dayReopenPortsFromData(
  data: DayReopenScreenData | undefined,
  worklist?: DayReopenData,
  reopenPort: DayReopenPort = NOOP_REOPEN_PORT,
): DayReopenPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_LOCKED_DAYS,
    // Default-deny: an absent permission list can read/reopen nothing (the server would refuse it anyway).
    mayRead: () => held.has(DAYCLOSE_READ_PERMISSION),
    mayReopen: () => held.has(DAYCLOSE_APPROVE_PERMISSION),
    reopenPort: () => reopenPort,
  };
}

/** Build the day-reopen session, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootDayReopen(
  data: DayReopenScreenData | undefined,
  worklist?: DayReopenData,
  reopenPort?: DayReopenPort,
): DayReopenSession | null {
  if (data === undefined) return null;
  return createDayReopenSession(
    { userId: data.userId === undefined ? null : data.userId },
    dayReopenPortsFromData(data, worklist, reopenPort),
  );
}

/** The reopen write goes to the BOX, not the cloud — cross-port on 127.0.0.1, the same reason the manager's
 *  close does (the box owns the locked day and re-queues the reopen; the cloud only has a synced-recording
 *  route). `laneWriteBase` names the box's lane socket; absent, there is no box to post to and the port stays a
 *  no-op that reports a lost link. A dropped link is a lost link, never a false "reopened" (P-08). */
export function openDayReopenPort(laneWriteBase: string | undefined, reopenedBy: string | null): DayReopenPort {
  if (laneWriteBase === undefined || reopenedBy === null || reopenedBy === '') return NOOP_REOPEN_PORT;
  return {
    post: async ({ dayCloseId, reason, approvedBy }): Promise<ReopenResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      try {
        const res = await fetchFn(`${laneWriteBase}/lane/day-reopen`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          // The reopener is the authenticated user at this screen (bound at boot from `dayReopenData.userId`);
          // the named approver rides as `approvedBy`, and the box enforces §28 (approver ≠ reopener).
          body: JSON.stringify({ dayCloseId, reopenedBy, reason, approvedBy }),
        });
        const body = (await res.json().catch(() => ({}))) as { reopened?: boolean };
        if (res.status >= 200 && res.status < 300 && body.reopened === true) return 'reopened';
        return 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** One row of `GET /v1/pos/day-close` — the cloud's locked-day list. */
interface RawDayCloseRow {
  readonly dayCloseId: string; readonly tradingDay: string; readonly closedBy: string; readonly closedAt: string; readonly locked: boolean;
}

/** Read the live locked-day worklist (a GET — read-only) and keep only the still-LOCKED days — the ones a
 *  reopen can act on. Returns null offline/refused so the shell keeps whatever it was showing. */
export async function fetchLockedDays(): Promise<DayReopenData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/pos/day-close', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    const body = (await res.json()) as { dayCloses?: readonly RawDayCloseRow[] };
    const locked: LockedDayView[] = (body.dayCloses ?? [])
      .filter((r) => r.locked)
      .map((r) => ({ dayCloseId: r.dayCloseId, tradingDay: r.tradingDay, closedBy: r.closedBy, closedAt: r.closedAt }));
    return { lockedCount: locked.length, locked };
  } catch {
    return null;
  }
}

// ── Stock health (M08 — read-only) ────────────────────────────────────────────────────────────────────────────

/** What the box tells the stock-health screen: who is looking, what they may read, and (optionally) a snapshot
 *  of the figures to render before/without a live read. */
export interface StockHealthScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly snapshot?: StockHealthData;
}

const INVENTORY_READ_PERMISSION = 'inventory.availability.read';
const EMPTY_STOCK_HEALTH: StockHealthData = Object.freeze({});

export function stockHealthPortsFromData(
  data: StockHealthScreenData | undefined,
  snapshot?: StockHealthData,
): StockHealthPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    snapshot: () => snapshot ?? data?.snapshot ?? EMPTY_STOCK_HEALTH,
    // Default-deny: an absent permission list can read nothing (the server would refuse it anyway).
    mayRead: () => held.has(INVENTORY_READ_PERMISSION),
  };
}

/** Build the stock-health session, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootStockHealth(
  data: StockHealthScreenData | undefined,
  snapshot?: StockHealthData,
): StockHealthSession | null {
  if (data === undefined) return null;
  return createStockHealthSession(
    { userId: data.userId === undefined ? null : data.userId },
    stockHealthPortsFromData(data, snapshot),
  );
}

/** Read one inventory GET and return its parsed body, or null (offline, refused, or unreadable). Read-only. */
async function getInventory(path: string): Promise<Record<string, unknown> | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read the live stock-health figures — the five inventory reads folded into one snapshot (all GETs, read-only).
 *  Each section is optional: a read that fails leaves that section absent rather than a false zero (P-08).
 *  Returns null only when NOTHING could be read, so the shell keeps whatever it was showing. */
export async function fetchStockHealth(): Promise<StockHealthData | null> {
  const [availability, exceptions, valuation, ageing, performance] = await Promise.all([
    getInventory('/v1/inventory/availability'),
    getInventory('/v1/inventory/exceptions'),
    getInventory('/v1/inventory/valuation'),
    getInventory('/v1/inventory/ageing'),
    getInventory('/v1/inventory/performance'),
  ]);
  if (availability === null && exceptions === null && valuation === null && ageing === null && performance === null) {
    return null;
  }

  const out: {
    availability?: StockHealthData['availability']; negative?: StockHealthData['negative'];
    valuation?: StockHealthData['valuation']; ageing?: StockHealthData['ageing'];
    performance?: StockHealthData['performance'];
    asAt: Record<string, string>;
  } = { asAt: {} };

  type Money = { readonly minor: number; readonly currency: string };
  const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  if (availability !== null && Array.isArray(availability['rows'])) {
    out.availability = (availability['rows'] as Record<string, unknown>[]).map((r) => ({
      productId: String(r['productId']), locationId: String(r['locationId']), onHandMinor: Number(r['onHandMinor']),
    }));
    const at = asStr(availability['asAt']); if (at !== undefined) out.asAt['availability'] = at;
  }
  if (exceptions !== null && Array.isArray(exceptions['negative'])) {
    out.negative = (exceptions['negative'] as Record<string, unknown>[]).map((r) => ({
      productId: String(r['productId']), locationId: String(r['locationId']), onHandMinor: Number(r['onHandMinor']),
      detail: String(r['detail'] ?? ''), ownerAction: String(r['ownerAction'] ?? ''),
    }));
    const at = asStr(exceptions['asAt']); if (at !== undefined) out.asAt['negative'] = at;
  }
  if (valuation !== null && typeof valuation['totalValueMinor'] === 'number') {
    const rows = Array.isArray(valuation['rows']) ? (valuation['rows'] as Record<string, unknown>[]) : [];
    const currency = ((rows[0]?.['value'] as Money | undefined)?.currency) ?? 'INR';
    out.valuation = { totalValueMinor: valuation['totalValueMinor'] as number, currency };
    const at = asStr(valuation['asAt']); if (at !== undefined) out.asAt['valuation'] = at;
  }
  if (ageing !== null && typeof ageing['totalValue'] === 'object' && ageing['totalValue'] !== null) {
    const total = ageing['totalValue'] as Money;
    const oldest = (ageing['oldestBucketValue'] as Money | undefined) ?? { minor: 0, currency: total.currency };
    out.ageing = {
      oldestBucketValueMinor: oldest.minor, totalValueMinor: total.minor,
      unvaluedMinor: Number(ageing['unvaluedMinor'] ?? 0), currency: total.currency,
    };
    const at = asStr(ageing['asAt']); if (at !== undefined) out.asAt['ageing'] = at;
  }
  if (performance !== null && typeof performance['turns'] === 'object' && performance['turns'] !== null) {
    const ratio = (v: unknown): { readonly kind: 'ratio'; readonly bp: number } | { readonly kind: 'not_meaningful'; readonly because: string } =>
      v as { kind: 'ratio'; bp: number } | { kind: 'not_meaningful'; because: string };
    out.performance = {
      turns: ratio(performance['turns']), daysOfCover: ratio(performance['daysOfCover']), gmroi: ratio(performance['gmroi']),
    };
    const at = asStr(performance['asAt']); if (at !== undefined) out.asAt['performance'] = at;
  }

  return out;
}

// ── Stored-value oversight (M17-FR-03/04 — read-only) ────────────────────────────────────────────────────────

/** What the box tells the stored-value oversight screen: who is looking and what they may read. */
export interface StoredValueScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

const STORED_VALUE_READ_PERMISSION = 'lp.case.read';

export function storedValuePortsFromData(
  data: StoredValueScreenData | undefined,
  current: StoredValueOversightData,
): StoredValueOversightPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    oversight: () => current,
    // Default-deny: an absent permission list reads nothing (the loss/books gate the cloud re-checks anyway).
    mayRead: () => held.has(STORED_VALUE_READ_PERMISSION),
  };
}

/** Build the stored-value oversight session over the given folded data, or null when the box carried no payload. */
export function bootStoredValue(
  data: StoredValueScreenData | undefined,
  current: StoredValueOversightData,
): StoredValueOversightSession | null {
  if (data === undefined) return null;
  return createStoredValueOversightSession(
    { userId: data.userId === undefined ? null : data.userId },
    storedValuePortsFromData(data, current),
  );
}

/** Read one stored-value GET and return its parsed body, or null (offline, refused, or unreadable). Read-only. */
async function getStoredValue(path: string): Promise<Record<string, unknown> | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read the store-wide redemption-velocity watch (GET, read-only); null when unreadable. */
export async function fetchStoredValueVelocity(): Promise<readonly VelocityFlagView[] | null> {
  const body = await getStoredValue('/v1/stored-value/velocity');
  if (body === null || !Array.isArray(body['flags'])) return null;
  return (body['flags'] as Record<string, unknown>[]).map((f) => ({
    instrumentId: String(f['instrumentId']), count: Number(f['count']), valueMinor: Number(f['valueMinor']),
    windowMinutes: Number(f['windowMinutes']), detail: String(f['detail'] ?? ''),
  }));
}

/** Reconcile the stored-value liability against the books' posted figure (GET, read-only); null when unreadable. */
export async function fetchStoredValueLiability(postedMinor: number): Promise<LiabilityReconciliationView | null> {
  if (!Number.isInteger(postedMinor) || postedMinor < 0) return null;
  const body = await getStoredValue(`/v1/stored-value/liability?posted=${postedMinor}`);
  if (body === null || typeof body['outstandingMinor'] !== 'number') return null;
  return {
    outstandingMinor: Number(body['outstandingMinor']), issuedMinor: Number(body['issuedMinor']),
    redeemedMinor: Number(body['redeemedMinor']), expiredMinor: Number(body['expiredMinor']),
    postedLiabilityMinor: Number(body['postedLiabilityMinor']), differenceMinor: Number(body['differenceMinor']),
    reconciles: body['reconciles'] === true, detail: String(body['detail'] ?? ''),
  };
}

/** Look up one household's cross-channel double-spends (GET, read-only); null when unreadable. */
export async function fetchStoredValueDoubleSpends(ownerRef: string): Promise<readonly DoubleSpendView[] | null> {
  if (ownerRef.trim() === '') return null;
  const body = await getStoredValue(`/v1/stored-value/households/${encodeURIComponent(ownerRef)}/double-spends`);
  if (body === null || !Array.isArray(body['doubleSpends'])) return null;
  return (body['doubleSpends'] as Record<string, unknown>[]).map((d) => ({
    instrumentId: String(d['instrumentId']), ownerRef: String(d['ownerRef']), overspentMinor: Number(d['overspentMinor']),
    channels: Array.isArray(d['channels']) ? (d['channels'] as unknown[]).map((c) => String(c)) : [],
    detail: String(d['detail'] ?? ''),
  }));
}

// ── Integration health (M32-FR-04 — read-only) ───────────────────────────────────────────────────────────────

export interface IntegrationHealthScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

const INTEGRATION_HEALTH_READ_PERMISSION = 'platform.health.read';

export function integrationHealthPortsFromData(
  data: IntegrationHealthScreenData | undefined,
  current: IntegrationHealthData,
): IntegrationHealthPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    health: () => current,
    // Default-deny: an absent permission list reads nothing (the cloud re-checks platform.health.read anyway).
    mayRead: () => held.has(INTEGRATION_HEALTH_READ_PERMISSION),
  };
}

/** Build the integration-health session over the given folded data, or null when the box carried no payload. */
export function bootIntegrationHealth(
  data: IntegrationHealthScreenData | undefined,
  current: IntegrationHealthData,
): IntegrationHealthSession | null {
  if (data === undefined) return null;
  return createIntegrationHealthSession(
    { userId: data.userId === undefined ? null : data.userId },
    integrationHealthPortsFromData(data, current),
  );
}

const ADAPTER_STATES: readonly AdapterHealthState[] = ['healthy', 'degraded', 'failing', 'silent', 'disabled'];

/** Read the live integration-health picture (a GET — read-only); null when unreadable (offline or refused). */
export async function fetchIntegrationHealth(): Promise<IntegrationHealthData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/integration/health', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (!Array.isArray(body['adapters'])) return null;
    const adapters: AdapterHealthView[] = (body['adapters'] as Record<string, unknown>[]).map((a) => {
      const state = ADAPTER_STATES.includes(a['state'] as AdapterHealthState) ? (a['state'] as AdapterHealthState) : 'silent';
      const mins = a['minutesSinceLastSuccess'];
      return {
        adapterId: String(a['adapterId']), category: String(a['category'] ?? ''), state,
        minutesSinceLastSuccess: mins === 'never' ? 'never' : Number(mins),
        consecutiveFailures: Number(a['consecutiveFailures'] ?? 0),
        shopKeepsTrading: a['shopKeepsTrading'] !== false,
        detail: String(a['detail'] ?? ''),
      };
    });
    return { adapters, posUnaffected: body['posUnaffected'] !== false, asAt: String(body['asAt'] ?? '') };
  } catch {
    return null;
  }
}

// ── Goods-receipt review (M07-FR-02/03 — read-only) ──────────────────────────────────────────────────────────

/** What the box tells the goods-receipt review screen: who is looking, what they may read, and (optionally) a
 *  snapshot of the deliveries. The GRN list is a LIVE cloud read (`GET /v1/inventory/goods-receipt`), refreshed by
 *  the shell when online; offline the screen shows its clearly-marked sample stand-in. Read-only — capture is the
 *  handheld's, on the offline dock (§31). */
export interface GoodsReceiptScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly snapshot?: GoodsReceiptData;
}

const EMPTY_GOODS_RECEIPT: GoodsReceiptData = Object.freeze({});

export function goodsReceiptPortsFromData(
  data: GoodsReceiptScreenData | undefined,
  snapshot?: GoodsReceiptData,
): GoodsReceiptPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    snapshot: () => snapshot ?? data?.snapshot ?? EMPTY_GOODS_RECEIPT,
    // Default-deny: an absent permission list can read nothing (the server would refuse it anyway).
    mayRead: () => held.has(INVENTORY_READ_PERMISSION),
  };
}

/** Build the goods-receipt review session, or `null` when the box carried no payload (shell shows the sample). */
export function bootGoodsReceipt(
  data: GoodsReceiptScreenData | undefined,
  snapshot?: GoodsReceiptData,
): GoodsReceiptSession | null {
  if (data === undefined) return null;
  return createGoodsReceiptSession(
    { userId: data.userId === undefined ? null : data.userId },
    goodsReceiptPortsFromData(data, snapshot),
  );
}

/** Read the live GRN list — one GET, read-only — and fold it into the review snapshot. Returns null when nothing
 *  could be read, so the shell keeps whatever it was showing. Each delivery's checked outcome (its valued
 *  discrepancies and whether it needs a second person) is carried through as-is; nothing is recomputed here. */
export async function fetchGoodsReceipt(): Promise<GoodsReceiptData | null> {
  const body = await getInventory('/v1/inventory/goods-receipt');
  if (body === null || !Array.isArray(body['receipts'])) return null;

  type Money = { readonly minor: number; readonly currency: string };
  const money = (v: unknown): Money => (typeof v === 'object' && v !== null ? v as Money : { minor: 0, currency: 'INR' });
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  const receipts: GrnRecordView[] = (body['receipts'] as Record<string, unknown>[]).map((g) => {
    const captured = (g['captured'] ?? {}) as Record<string, unknown>;
    const lines = Array.isArray(captured['lines']) ? captured['lines'] as Record<string, unknown>[] : [];
    const dv = money(captured['discrepancyValue']);
    const discrepancies: GrnDiscrepancyView[] = (Array.isArray(captured['discrepancies']) ? captured['discrepancies'] as Record<string, unknown>[] : []).map((d) => {
      const val = money(d['value']);
      return {
        kind: String(d['kind']) as GrnDiscrepancyView['kind'],
        productId: String(d['productId'] ?? ''), quantityMinor: num(d['quantityMinor']),
        valueMinor: val.minor, currency: val.currency,
        requiresApproval: d['requiresApproval'] === true, detail: String(d['detail'] ?? ''),
      };
    });
    return {
      grnId: String(g['grnId'] ?? ''), number: String(g['number'] ?? ''),
      poId: typeof g['poId'] === 'string' ? g['poId'] : null,
      warehouseId: String(g['warehouseId'] ?? ''), receivedBy: String(g['receivedBy'] ?? ''),
      receivedAt: String(g['receivedAt'] ?? ''),
      requiresApproval: captured['requiresApproval'] === true,
      discrepancyValueMinor: dv.minor, currency: dv.currency,
      sellableMinor: num(g['availableMinor']),
      quarantinedMinor: lines.reduce((s, l) => s + num(l['quarantinedMinor']), 0),
      rejectedMinor: lines.reduce((s, l) => s + num(l['rejectedMinor']), 0),
      discrepancies,
    };
  });

  // The "as of" is the moment the list was read — an honest freshness stamp for a live pull.
  return { receipts, asAt: new Date().toISOString() };
}

// ── Risk-acceptance / compliance-gates (M34-FR-04) ────────────────────────────────────────────────────────────

/** What the box tells the risk-acceptance screen: who is looking, what they may do, and (optionally) the
 *  worklist it last carried. The blocked gates are a LIVE cloud read (`GET /v1/compliance/gates/blocked`)
 *  refreshed by the shell when online; offline the screen shows its clearly-marked sample stand-in. */
export interface RiskAcceptanceData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: BlockedGatesData;
}

const RISK_READ_PERMISSION = 'compliance.risk.read';
const RISK_MANAGE_PERMISSION = 'compliance.risk.manage';
const EMPTY_BLOCKED_GATES: BlockedGatesData = Object.freeze({ count: 0, blocked: [] });
const NOOP_ACCEPT_PORT: RiskAcceptPort = { post: async () => 'lost_link' };

export function riskAcceptancePortsFromData(
  data: RiskAcceptanceData | undefined,
  worklist?: BlockedGatesData,
  acceptPort: RiskAcceptPort = NOOP_ACCEPT_PORT,
): RiskAcceptancePorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? EMPTY_BLOCKED_GATES,
    // Default-deny: an absent permission list can read/accept nothing (the server would refuse it anyway).
    mayRead: () => held.has(RISK_READ_PERMISSION),
    mayManage: () => held.has(RISK_MANAGE_PERMISSION),
    acceptPort: () => acceptPort,
  };
}

/** Build the risk-acceptance session, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootRiskAcceptance(
  data: RiskAcceptanceData | undefined,
  worklist?: BlockedGatesData,
  acceptPort?: RiskAcceptPort,
): RiskAcceptanceSession | null {
  if (data === undefined) return null;
  return createRiskAcceptanceSession(
    { userId: data.userId === undefined ? null : data.userId },
    riskAcceptancePortsFromData(data, worklist, acceptPort),
  );
}

/** The authenticated POST of an acceptance decision — the accepter's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal. The riskId rides in the URL; the server records the acceptance in the caller's own name and enforces
 *  the name+rationale rule (§28). */
function openRiskAcceptPort(): RiskAcceptPort {
  return {
    post: async ({ riskId, rationale }): Promise<AcceptResult> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `risk-accept-${riskId}`;
      try {
        const res = await fetchFn(`/v1/compliance/risks/${encodeURIComponent(riskId)}/acceptance`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ rationale }),
        });
        return res.status >= 200 && res.status < 300 ? 'accepted' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live blocked-gates worklist (a GET — read-only). Returns null offline/refused so the shell keeps
 *  whatever it was showing and its stale strip says the page is what the box last told it. */
export async function fetchBlockedGates(): Promise<BlockedGatesData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn('/v1/compliance/gates/blocked', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    const body = (await res.json()) as { blocked?: readonly GateBlockView[] };
    const blocked = body.blocked ?? [];
    return { count: blocked.length, blocked };
  } catch {
    return null;
  }
}

// ── Data import/export console (M30) ────────────────────────────────────────────────────────────────────────

/** One import template the box ships — the full spec the validate/commit routes need in their body. */
export interface FullImportTemplate {
  readonly id: string; readonly domain: string; readonly label: string; readonly financial: boolean;
  readonly columns: readonly { readonly name: string; readonly type: string }[];
  readonly keyColumns: readonly string[];
}

/** What the box tells the data import/export console: who is looking, what they hold, and the store's import
 *  templates. The exportable domains and export log come LIVE (GET /v1/export, GET /v1/exports); offline the
 *  screen shows its sample stand-in. */
export interface DataIoData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly importTemplates?: readonly FullImportTemplate[];
  readonly exportDomains?: readonly ExportDomainView[];
  readonly recentExports?: readonly ExportAuditView[];
}

/** The live catalogue + log the shell last read. */
export interface DataIoLive { readonly domains: readonly ExportDomainView[]; readonly exports: readonly ExportAuditView[]; }

const EXPORT_PERMISSION = 'export.read';
const IMPORT_READ_PERMISSION = 'purchase.import.read';
const IMPORT_COMMIT_PERMISSION = 'purchase.import.record';

/** POST an export (POST /v1/export/:domain) under the caller's own session — an audited artifact. */
async function postExport(domain: string): Promise<ExportResult> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return 'lost_link';
  const key = globalThis.crypto?.randomUUID?.() ?? `export-${domain}`;
  try {
    const res = await fetchFn(`/v1/export/${encodeURIComponent(domain)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
      credentials: 'same-origin', body: '{}',
    });
    return res.status >= 200 && res.status < 300 ? 'exported' : 'refused';
  } catch { return 'lost_link'; }
}

/** POST a validate (POST /v1/import/validate) — a preview, writes nothing. Resolves the full template body. */
async function postValidate(template: FullImportTemplate | undefined, req: { text: string; declaredTotalMinor?: number }): Promise<ValidateResult> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined || template === undefined) return 'refused';
  try {
    const res = await fetchFn('/v1/import/validate', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({
        template: { id: template.id, domain: template.domain, columns: template.columns, keyColumns: template.keyColumns },
        text: req.text,
        ...(req.declaredTotalMinor !== undefined ? { declaredTotalMinor: req.declaredTotalMinor } : {}),
      }),
    });
    if (res.status >= 400) return 'refused';
    const body = (await res.json()) as { preview?: {
      totalRows: number; validCount: number; errorRowCount: number;
      errors: readonly { line: number; column: string; message: string }[];
      duplicatesForReview: readonly unknown[]; sumMinor?: number; reconciles?: boolean; commitReady: boolean;
    } };
    const p = body.preview;
    if (p === undefined) return 'refused';
    const view: ImportPreviewView = {
      totalRows: p.totalRows, validCount: p.validCount, errorRowCount: p.errorRowCount,
      errors: p.errors.map((e) => ({ line: e.line, column: e.column, message: e.message })),
      duplicateCount: p.duplicatesForReview.length,
      ...(p.sumMinor !== undefined ? { sumMinor: p.sumMinor } : {}),
      ...(p.reconciles !== undefined ? { reconciles: p.reconciles } : {}),
      commitReady: p.commitReady,
    };
    return view;
  } catch { return 'lost_link'; }
}

/** POST a commit (POST /v1/import/commit) under §28 — the approver is a SEPARATE person named on the screen;
 *  the uploader is the caller's own session identity. The server re-validates and enforces §28. */
async function postCommit(
  template: FullImportTemplate | undefined,
  req: { text: string; jobId: string; approver: string; declaredTotalMinor?: number },
  uploadedBy: string | undefined,
): Promise<CommitResult> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined || template === undefined) return 'refused';
  const key = globalThis.crypto?.randomUUID?.() ?? `import-${req.jobId}`;
  try {
    const res = await fetchFn('/v1/import/commit', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({
        jobId: req.jobId,
        template: { id: template.id, domain: template.domain, columns: template.columns, keyColumns: template.keyColumns },
        text: req.text,
        approval: { decidedBy: req.approver, status: 'approved' },
        ...(uploadedBy !== undefined ? { uploadedBy } : {}),
        ...(req.declaredTotalMinor !== undefined ? { declaredTotalMinor: req.declaredTotalMinor } : {}),
      }),
    });
    return res.status >= 200 && res.status < 300 ? 'committed' : 'refused';
  } catch { return 'lost_link'; }
}

export function dataIoPortsFromData(data: DataIoData | undefined, live?: DataIoLive): DataIoPorts {
  const held = new Set(data?.permissions ?? []);
  const templates = data?.importTemplates ?? [];
  const findTemplate = (id: string): FullImportTemplate | undefined => templates.find((t) => t.id === id);
  return {
    exportDomains: () => live?.domains ?? data?.exportDomains ?? [],
    recentExports: () => live?.exports ?? data?.recentExports ?? [],
    importTemplates: () => templates.map((t) => ({ id: t.id, domain: t.domain, label: t.label, financial: t.financial })),
    mayExport: () => held.has(EXPORT_PERMISSION),
    mayImport: () => held.has(IMPORT_READ_PERMISSION),
    mayCommitImport: () => held.has(IMPORT_COMMIT_PERMISSION),
    runExport: (domain) => postExport(domain),
    validate: (req) => postValidate(findTemplate(req.templateId), req),
    commit: (req) => postCommit(findTemplate(req.templateId), req, data?.userId),
  };
}

/** Build the data import/export session, or `null` when the box carried no payload (shell shows the sample). */
export function bootDataIo(data: DataIoData | undefined, live?: DataIoLive): DataIoSession | null {
  if (data === undefined) return null;
  return createDataIoSession({ userId: data.userId === undefined ? null : data.userId }, dataIoPortsFromData(data, live));
}

/** Read the export catalogue + log live (GETs — read-only). Returns null offline so the screen keeps its view. */
export async function fetchDataIoLive(): Promise<DataIoLive | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const [dRes, eRes] = await Promise.all([
      fetchFn('/v1/export', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' }),
      fetchFn('/v1/exports', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' }),
    ]);
    if (dRes.status >= 400 || eRes.status >= 400) return null;
    const dBody = (await dRes.json()) as { domains?: readonly ExportDomainView[] };
    const eBody = (await eRes.json()) as { exports?: readonly ExportAuditView[] };
    return { domains: dBody.domains ?? [], exports: eBody.exports ?? [] };
  } catch { return null; }
}

// ── Workforce guidance inbox (A10) — the exact mirror of the Operations inbox above ────────────────────────

/** What the box tells the Workforce guidance inbox screen: who is looking, what they may do, and (optionally)
 *  the worklist it last carried. The worklist is a LIVE cloud read (`GET /v1/ai/workforce/worklist`) refreshed
 *  by the shell when online; offline the screen shows its clearly-marked sample stand-in. */
export interface WorkforceInboxData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly worklist?: WorkforceWorklistData;
}

const WORKFORCE_READ_PERMISSION = 'ai.proposal.read';
const WORKFORCE_DISMISS_PERMISSION = 'ai.suggestion.dismiss';
const INACTIVE_WORKFORCE_WORKLIST: WorkforceWorklistData = Object.freeze({ agentActive: false, open: [], dismissed: [] });
const NOOP_WORKFORCE_DISMISS_PORT: WorkforceDismissPort = { post: async () => 'lost_link' };

export function workforceInboxPortsFromData(
  data: WorkforceInboxData | undefined,
  worklist?: WorkforceWorklistData,
  dismissPort: WorkforceDismissPort = NOOP_WORKFORCE_DISMISS_PORT,
): WorkforceInboxPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    worklist: () => worklist ?? data?.worklist ?? INACTIVE_WORKFORCE_WORKLIST,
    // Default-deny: an absent permission list can read/dismiss nothing (the server would refuse it anyway).
    mayRead: () => held.has(WORKFORCE_READ_PERMISSION),
    mayDismiss: () => held.has(WORKFORCE_DISMISS_PERMISSION),
    dismissPort: () => dismissPort,
  };
}

/** Build the Workforce inbox, or `null` when the box carried no payload for it (shell shows the sample). */
export function bootWorkforceInbox(
  data: WorkforceInboxData | undefined,
  worklist?: WorkforceWorklistData,
  dismissPort?: WorkforceDismissPort,
): WorkforceInboxSession | null {
  if (data === undefined) return null;
  return createWorkforceInboxSession(
    { userId: data.userId === undefined ? null : data.userId },
    workforceInboxPortsFromData(data, worklist, dismissPort),
  );
}

/** The authenticated POST of a manager's set-aside/reopen decision — the manager's OWN session cookie
 *  (`credentials: 'same-origin'`), never a service token. A network/timeout is a retryable lost link, not a
 *  refusal, so a dropped connection never reads as "the server said no". The AI never calls this — a person does. */
function openWorkforceDismissPort(): WorkforceDismissPort {
  return {
    post: async ({ findingId, dismissed, reason }): Promise<DismissOutcome> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return 'lost_link';
      const key = globalThis.crypto?.randomUUID?.() ?? `wf-dismiss-${findingId}-${String(dismissed)}`;
      const body = dismissed ? { findingId, reason } : { findingId, reopen: true };
      try {
        const res = await fetchFn('/v1/ai/workforce/dismissals', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        return res.status >= 200 && res.status < 300 ? 'recorded' : 'refused';
      } catch {
        return 'lost_link';
      }
    },
  };
}

/** Read the live worklist (a GET — read-only, commits nothing). Returns null offline/refused so the shell
 *  keeps whatever it was showing and its stale strip says the page is what the box last told it. */
export async function fetchWorkforceWorklist(): Promise<WorkforceWorklistData | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null; // off-browser (tests inject their own http)
  try {
    const res = await fetchFn('/v1/ai/workforce/worklist', {
      method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin',
    });
    if (res.status >= 400) return null;
    return (await res.json()) as WorkforceWorklistData;
  } catch {
    return null;
  }
}

/** What the box tells the device fleet-manager screen — who is looking and what they may do (M33-FR-02/04).
 *  The fleet itself is fetched from the cloud fleet-health call (wired next); the shell shows a sample
 *  stand-in until then. `summary`/`devices` are carried when a later cloud→box sync provides them. */
export interface FleetData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
  readonly summary?: FleetSummaryRollup;
  readonly devices?: readonly FleetDeviceRow[];
}

const FLEET_READ_PERMISSION = 'platform.health.read';
const FLEET_MANAGE_PERMISSION = 'platform.device.manage';
const EMPTY_FLEET_ROLLUP: FleetSummaryRollup = { total: 0, trading: 0, blocked: 0, mustUpgrade: 0, silent: 0, byVersion: {} };

export function fleetPortsFromData(
  data: FleetData | undefined,
  outbox: SyncOutbox = new SyncOutbox(),
  deliveryPort?: FleetDeliveryPort,
): FleetPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    fleet: () => ({ summary: data?.summary ?? EMPTY_FLEET_ROLLUP, devices: data?.devices ?? [] }),
    // Default-deny: an absent permission list can read/manage nothing (the server would refuse it anyway).
    mayRead: () => held.has(FLEET_READ_PERMISSION),
    mayManage: () => held.has(FLEET_MANAGE_PERMISSION),
    outbox: () => outbox,
    ...(deliveryPort === undefined ? {} : { deliveryPort: () => deliveryPort }),
  };
}

/** Build the device fleet-manager screen, or `null` when the box carried no payload for it. */
export function bootFleet(
  data: FleetData | undefined,
  outbox: SyncOutbox = new SyncOutbox(),
  deliveryPort?: FleetDeliveryPort,
): FleetSession | null {
  if (data === undefined) return null;
  return createFleetSession(
    { userId: data.userId === undefined ? null : data.userId },
    fleetPortsFromData(data, outbox, deliveryPort),
  );
}

/** The device-backed outbox the fleet manager commits register/block/retire actions to — survives a reload (§31). */
function openFleetOutbox(): SyncOutbox {
  const storage = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
  const onProblem = (why: string): void => { fleetStorageProblem = why; };
  return openDeviceOutbox(guardedStore('sre.fleet-outbox', storage, onProblem), onProblem);
}

/** The last storage problem the fleet outbox hit, so the shell can show it — never silent (P-08). */
export let fleetStorageProblem: string | undefined;

/**
 * The concrete operator-session delivery port for the fleet (M33-FR-02/04, P-04/P-05): POSTs a queued device
 * change to its idempotent registry route **under the operator's own session** — `credentials: 'same-origin'`
 * carries their auth cookie, NEVER a service token, because blocking or retiring a device changes central
 * privilege state and must reach the registry as the authorised person. `register` goes to `…/register` with
 * the device's identity; `block`/`retire`/`reinstate` go to `…/status` with the target status and the reason.
 * The idempotency key is the command's own, so a retry cannot apply a change twice. Returns the HTTP status,
 * or 0 for a network/timeout — which the delivery step treats as retryable, so a lost link holds the change
 * pending and never condemns it.
 */
function openFleetDeliveryPort(): FleetDeliveryPort {
  const post = async (path: string, body: unknown, idempotencyKey: string): Promise<number> => {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (fetchFn === undefined) return 0; // off-browser (tests inject their own) — treat as a lost link
    try {
      const res = await fetchFn(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      return res.status;
    } catch {
      return 0;
    }
  };
  return {
    post: (command: DeviceChangeCommand, idempotencyKey: string) => {
      const { path, body } = deviceChangeRequest(command);
      return post(path, body, idempotencyKey);
    },
  };
}

/** The device-backed outbox the GST-returns screen queues governance actions to — survives a reload (§31). */
function openGstReturnsOutbox(): SyncOutbox {
  const storage = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
  const onProblem = (why: string): void => { gstReturnsStorageProblem = why; };
  return openDeviceOutbox(guardedStore('sre.gst-returns-outbox', storage, onProblem), onProblem);
}

/** The last storage problem the GST-returns outbox hit, so the shell can show it — never silent (P-08). */
export let gstReturnsStorageProblem: string | undefined;

/** The device-backed outbox the catalogue screen commits a product publish to — survives a reload (§31). */
function openCatalogueOutbox(): SyncOutbox {
  const storage = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
  const onProblem = (why: string): void => { catalogueStorageProblem = why; };
  return openDeviceOutbox(guardedStore('sre.catalogue-outbox', storage, onProblem), onProblem);
}

/** The last storage problem the catalogue outbox hit, so the shell can show it — never silent (P-08). */
export let catalogueStorageProblem: string | undefined;

// ── Products waiting to publish — the review-queue screen (ADR-0013 slice 4, M03-FR-01/03) ──────────────────

/**
 * The concrete operator-session delivery port (ADR-0013): POSTs a ready publish to the idempotent cloud route
 * `POST /v1/catalogue/products/:productId/publish` **under the operator's own session** — `credentials:
 * 'same-origin'` carries their auth cookie, NEVER a service token. The publish route reads `{ product,
 * categories }` (the barcode register is a separate route — assigning the command's barcodes there is the
 * documented follow-up); the idempotency key is the command's own, so a retry cannot create a duplicate
 * product. Returns the HTTP status, or 0 for a network/timeout failure — which the delivery step treats as
 * retryable, so a lost link holds the publish pending and never condemns it.
 */
function openPublishDeliveryPort(): PublishDeliveryPort {
  // One operator-authenticated POST, shared by both legs. `credentials: 'same-origin'` carries the operator's
  // OWN auth cookie (never a service token — ADR-0013); a network/timeout returns 0, which the delivery leg
  // treats as retryable so a lost link holds the publish pending and never loses it.
  const post = async (path: string, body: unknown, idempotencyKey: string): Promise<number> => {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (fetchFn === undefined) return 0; // off-browser (tests inject their own http) — treat as a lost link
    try {
      const res = await fetchFn(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      return res.status;
    } catch {
      return 0;
    }
  };
  const http: PublishHttp = {
    publishProduct: (payload: ProductPublishPayload, key: string) =>
      post(`/v1/catalogue/products/${encodeURIComponent(payload.product.productId)}/publish`, { product: payload.product, categories: payload.categories }, key),
    assignBarcode: (productId: string, barcode: ProductPublishBarcode, key: string) =>
      post(
        `/v1/catalogue/products/${encodeURIComponent(productId)}/barcodes/${encodeURIComponent(barcode.code)}`,
        { kind: barcode.kind, ...(barcode.level === undefined ? {} : { level: barcode.level }) },
        key,
      ),
  };
  // Delivering one command means publishing the product AND assigning its barcodes; deliverOnePublish
  // sequences the two and collapses the result into one status the outbox transitions on.
  return { post: (payload, idempotencyKey) => deliverOnePublish(payload, idempotencyKey, http) };
}

/**
 * What the ERP server tells the products-to-publish screen. The CONTEXT is a LIVE authentication fact — the
 * operator's CURRENT permissions and session freshness — injected by the signed-in ERP session, NEVER read
 * from the periodically-pulled offline pack (that would be the stale-authorisation snapshot ADR-0013 control 3
 * forbids acting on). The queue itself is the device-backed catalogue outbox, not this payload.
 */
export interface ProductPublishReviewData {
  readonly userId?: string;
  readonly tenantId?: string;
  /** The permission codes the operator holds RIGHT NOW. */
  readonly permissions?: readonly string[];
  /** Is there a live authenticated session? Defaults true (the page was served to a signed-in session). */
  readonly sessionActive?: boolean;
  /** Is the operator a current member of the tenant? Defaults true (the ERP served them this tenant's screen). */
  readonly tenantMember?: boolean;
  /** Age of the last MFA/re-auth in seconds — a bulk or sensitive publish needs a fresh one (control 4). */
  readonly mfaFreshSeconds?: number;
  /** Creators who have since lost the authority / left, so their queued items are routed, not published. */
  readonly revokedCreators?: readonly string[];
  /** True when publishing the whole batch at once — bulk needs a fresh re-auth (control 4). */
  readonly bulk?: boolean;
}

export function productPublishReviewPortsFromData(
  data: ProductPublishReviewData,
  outbox: SyncOutbox<string, ProductPublishPayload>,
  deliveryPort: PublishDeliveryPort,
): ProductPublishReviewPorts {
  return {
    // Re-read on EVERY render, never captured once — the classifier re-evaluates from this live context.
    context: () => ({
      userId: data.userId ?? '',
      tenantId: data.tenantId ?? 'tenant',
      // Default-deny: an absent permission list can publish nothing (the server would refuse it anyway).
      permissions: new Set(data.permissions ?? []),
      // The page was served to a signed-in session in a tenant, so these default TRUE; the ERP sets them
      // false when it knows otherwise (a locked session, a tenant the operator was removed from mid-session).
      sessionActive: data.sessionActive !== false,
      tenantMember: data.tenantMember !== false,
      ...(data.mfaFreshSeconds === undefined ? {} : { mfaFreshSeconds: data.mfaFreshSeconds }),
      ...(data.revokedCreators === undefined ? {} : { revokedCreators: new Set(data.revokedCreators) }),
      ...(data.bulk === undefined ? {} : { bulk: data.bulk }),
    }),
    outbox: () => outbox,
    deliveryPort: () => deliveryPort,
  };
}

/**
 * Build the products-to-publish screen, or `null` when the ERP told this screen nothing (it then shows its
 * clearly-marked sample stand-in). The outbox is the SAME device-backed catalogue queue the Save button
 * commits publishes to, so what was queued there is exactly what is reviewed and delivered here.
 */
export function bootProductPublishReview(
  data: ProductPublishReviewData | undefined,
  outbox: SyncOutbox<string, ProductPublishPayload>,
  deliveryPort: PublishDeliveryPort,
): ProductPublishReviewSession | null {
  if (data === undefined) return null;
  return createProductPublishReviewSession(
    { userId: data.userId === undefined ? null : data.userId },
    productPublishReviewPortsFromData(data, outbox, deliveryPort),
  );
}

// ── Payroll (owner directive; docs/design/screens/payroll.md) ────────────────────────────────────────────
//
// Payroll is deliberately UNLIKE the other screens: it is served ONLINE-FIRST, holds the most sensitive data
// in the shop, and is NEVER put on the offline store box that feeds shared floor devices. So there is no
// store-pack section, no offline-cache, and `online` is read live from the browser. When no payload is
// injected the screen boots a clearly-marked DEMO session on the SAME tested model — so the copy and rules
// are single-sourced and a person is never shown real payroll by accident.

/** What an online payroll server tells the screen. Sensitive identifiers should already be masked upstream. */
export interface PayrollData {
  readonly userId?: string;
  /** Permission codes this user holds — gates visibility the same way the server does. */
  readonly permissions?: readonly string[];
  readonly demo?: boolean;
  readonly payPeriod?: string;
  readonly run?: PayRunAggregate;
  readonly employees?: readonly PayrollEmployeeInput[];
  /** The run's aggregated statutory money (the journal input). PII-free. */
  readonly totals?: PayrollTotals;
  /** A leaver's full-and-final settlement inputs, when the screen is showing a settlement. PII-free. */
  readonly settlement?: PayrollSettlementInput;
  /** The net of the previous version of this run, for a draft/version comparison. */
  readonly previousNetMinor?: number;
}

const PAYROLL_VIEW_PERMISSION = 'payroll.statutory.read';
/** How fresh an MFA re-auth must be to release a sensitive payroll action. */
const PAYROLL_REAUTH_FRESH_SECONDS = 120;

/** Live connectivity, read from the browser where present; assumed online off-browser (tests supply their own). */
function browserOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine !== false; // undefined (off-browser) → treated as online
}

function nowMs(): number {
  return (globalThis as { Date?: { now(): number } }).Date?.now?.() ?? 0;
}

/**
 * The client-side re-auth clock. A sensitive payroll action needs a FRESH MFA confirmation; the shell calls
 * `window.payrollReauth()` when the person completes the MFA step, which stamps `reauthAt`. The session reads
 * the age live, so a confirmation that was fresh a minute ago goes stale on its own. Deliberately in memory
 * only — never persisted (payroll stores nothing on the device).
 */
let payrollReauthAt: number | undefined;
export function markPayrollReauthenticated(): void { payrollReauthAt = nowMs(); }
function payrollReauthAgeSeconds(): number | undefined {
  return payrollReauthAt === undefined ? undefined : Math.max(0, (nowMs() - payrollReauthAt) / 1000);
}

export function payrollPortsFromData(data: PayrollData): PayrollPorts {
  const held = new Set(data.permissions ?? []);
  return {
    mayView: () => held.has(PAYROLL_VIEW_PERMISSION),
    run: () => data.run,
    employees: () => data.employees ?? [],
    totals: () => data.totals,
    settlement: () => data.settlement,
    previousNetMinor: () => data.previousNetMinor,
    online: browserOnline,
    reauthAgeSeconds: payrollReauthAgeSeconds,
    payPeriod: data.payPeriod ?? '',
  };
}

/** The DEMO run shown when no real payload is injected — two payable staff and one deliberately blocked. */
const DEMO_PAYROLL_EMPLOYEES: readonly PayrollEmployeeInput[] = Object.freeze([
  { employeeId: 'DEMO-1', name: 'Asha (demo)', department: 'Grocery', grossMinor: 30_000_00, totalDeductionsMinor: 3_600_00, netPayMinor: 26_400_00, bankAccount: '000000000001', bankIfsc: 'DEMO0000001', pan: 'DEMOP1234D', uan: '100000000001', aadhaar: '000000000001' },
  { employeeId: 'DEMO-2', name: 'Bala (demo)', department: 'Chill', grossMinor: 22_000_00, totalDeductionsMinor: 2_100_00, netPayMinor: 19_900_00, bankAccount: '000000000002', bankIfsc: 'DEMO0000001', pan: 'DEMOP5678D', uan: '100000000002', aadhaar: '000000000002' },
  { employeeId: 'DEMO-3', name: 'Chandra (demo)', department: 'Grocery', grossMinor: 18_000_00, totalDeductionsMinor: 18_500_00, netPayMinor: -500_00, bankAccount: '', pan: 'DEMOP9012D', uan: '100000000003', aadhaar: '000000000003' },
]);

/**
 * Build the payroll screen. **Always returns a session** — a real one from an injected payload, or a
 * DEMO session (clearly flagged) on the same tested model when nothing was injected — so the screen is never
 * blank and never accidentally shows real payroll.
 */
export function bootPayroll(data: PayrollData | undefined): PayrollSession {
  if (data === undefined) {
    // A DEMO draft on the real model. `demo: true` makes the shell show "DEMO DATA — NOT REAL PAYROLL".
    const demoRun = foldPayRun('DEMO', [{ kind: 'drafted', payPeriod: '2026-08', by: 'demo-user', at: '2026-08-31T00:00:00.000Z', netTotalMinor: 46_300_00, employeeCount: 3 }]);
    return createPayrollSession(
      { userId: 'demo-user', demo: true, reauthFreshWithinSeconds: PAYROLL_REAUTH_FRESH_SECONDS },
      {
        mayView: () => true,
        run: () => demoRun,
        employees: () => DEMO_PAYROLL_EMPLOYEES,
        totals: () => undefined,
        settlement: () => undefined,
        previousNetMinor: () => undefined,
        online: browserOnline,
        reauthAgeSeconds: payrollReauthAgeSeconds,
        payPeriod: '2026-08',
      },
    );
  }
  return createPayrollSession(
    { userId: data.userId === undefined ? null : data.userId, demo: data.demo === true, reauthFreshWithinSeconds: PAYROLL_REAUTH_FRESH_SECONDS },
    payrollPortsFromData(data),
  );
}

// ── Payroll employee self-service (own payslip) — a SEPARATE surface, permission and shell ───────────────

const PAYROLL_ESS_PERMISSION = 'payroll.ess.self';

/**
 * What the online payroll server tells the self-service screen. `requesterEmployeeId` is the AUTHENTICATED
 * principal the box was told from the signed-in session — never a value the page can set. The session refuses
 * unless it equals `subjectEmployeeId`, so this is the forge-proof own-record control.
 */
export interface PayrollEssData {
  readonly requesterEmployeeId?: string;
  readonly subjectEmployeeId?: string;
  readonly permissions?: readonly string[];
  readonly demo?: boolean;
  readonly payslip?: PayrollPayslip;
  readonly settlement?: PayrollSettlement;
}

export function payrollEssPortsFromData(data: PayrollEssData): PayrollEssPorts {
  const held = new Set(data.permissions ?? []);
  return {
    mayView: () => held.has(PAYROLL_ESS_PERMISSION),
    payslip: () => data.payslip,
    settlement: () => data.settlement,
    online: browserOnline,
    reauthAgeSeconds: payrollReauthAgeSeconds,
  };
}

/** A DEMO own-payslip, built on the real engine, shown when no real payload is injected. */
function demoEssPayslip(): PayrollPayslip {
  const params = resolveStatutoryParams(DEFAULT_STATUTORY_SCHEDULE, '2026-08-31');
  return buildPayslip({
    onDate: '2026-08-31',
    components: [
      { code: 'BASIC', monthlyMinor: 20_000_00, partOfPfWage: true, partOfGross: true },
      { code: 'HRA', monthlyMinor: 10_000_00, partOfGross: true },
    ],
    attendance: { calendarDaysInMonth: 31, paidDays: 31 },
    params,
  });
}

/** Build the self-service screen. Always returns a session — a DEMO own-payslip when nothing was injected. */
export function bootPayrollEss(data: PayrollEssData | undefined): PayrollEssSession {
  if (data === undefined) {
    const payslip = demoEssPayslip();
    return createPayrollEssSession(
      { requesterEmployeeId: 'DEMO-EMP', subjectEmployeeId: 'DEMO-EMP', demo: true, reauthFreshWithinSeconds: PAYROLL_REAUTH_FRESH_SECONDS },
      { mayView: () => true, payslip: () => payslip, settlement: () => undefined, online: browserOnline, reauthAgeSeconds: payrollReauthAgeSeconds },
    );
  }
  return createPayrollEssSession(
    {
      // The requester is the authenticated principal — never a page-settable value.
      requesterEmployeeId: data.requesterEmployeeId === undefined ? null : data.requesterEmployeeId,
      subjectEmployeeId: data.subjectEmployeeId ?? '',
      demo: data.demo === true,
      reauthFreshWithinSeconds: PAYROLL_REAUTH_FRESH_SECONDS,
    },
    payrollEssPortsFromData(data),
  );
}

/** What the box tells the admin and security screen. */
export interface AdminData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly now?: string;
  readonly dormantAfterDays?: number;
  readonly accounts?: readonly UserAccount[];
  readonly roles?: readonly Role[];
  readonly assignments?: readonly RoleAssignment[];
  readonly supportSessions?: readonly SupportSession[];
  readonly devices?: readonly Device[];
  /** **Absent means nothing is being enforced**, which is not a compliant fleet. */
  readonly versionPolicy?: VersionPolicy;
  readonly auditRecords?: readonly AuditRecord[];
  /** **Absent means the shop has never decided**, which is not "nothing to delete". */
  readonly retentionPolicies?: readonly RetentionPolicy[];
  readonly legalHolds?: readonly LegalHold[];
}

export function adminPortsFromData(data: AdminData | undefined): AdminPorts {
  return {
    accounts: () => data?.accounts ?? [],
    roles: () => data?.roles ?? [],
    assignments: () => data?.assignments ?? [],
    supportSessions: () => data?.supportSessions ?? [],
    devices: () => data?.devices ?? [],
    // NOT defaulted. No policy means nothing is being enforced, and judging a fleet against a
    // minimum nobody set would report it compliant with a rule the shop never made.
    versionPolicy: () => data?.versionPolicy,
    auditRecords: () => data?.auditRecords ?? [],
    // An empty list here genuinely means "no policies", which the session reads as undecided.
    retentionPolicies: () => data?.retentionPolicies ?? [],
    legalHolds: () => data?.legalHolds ?? [],
  };
}

/** Build the admin screen, or `null` when the box was told nothing about who administers this shop. */
export function bootAdmin(data: AdminData | undefined): AdminSession | null {
  if (data === undefined) return null;
  return createAdminSession(
    {
      tenantId: 'tenant',
      // NOT defaulted. Letting somebody into live data carries the name of whoever let them in.
      userId: data.userId === undefined ? null : data.userId,
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      dormantAfterDays: data.dormantAfterDays ?? 0,
    },
    adminPortsFromData(data),
  );
}

/** What the box tells the store-setup screen: who is looking, and the setup status the API computed. */
export interface SetupData {
  readonly userId?: string;
  readonly storeId?: string;
  /** The tenant's setup status from GET /v1/platform/setup. Absent → the screen was told nothing. */
  readonly status?: SetupStatus;
}

/**
 * Build the store-setup screen, or `null` when the box carried no setup status — the screen then
 * shows its sample stand-in and says so, rather than inventing an "all done" state from nothing.
 */
export function bootSetup(data: SetupData | undefined): SetupSession | null {
  if (data === undefined || data.status === undefined) return null;
  const status = data.status;
  return createSetupSession(
    {
      tenantId: data.storeId ?? 'tenant',
      // NOT defaulted. A change to how the whole store trades carries the name of who made it.
      userId: data.userId === undefined ? null : data.userId,
    },
    { status: () => status },
  );
}

/**
 * The editing surface the store-setup page drives: the tested controller and parser, plus the
 * browser-only I/O (save, reload, re-present) kept thin so all the decisions stay in tested code.
 */
export interface SetupEditingApi {
  readonly controller: SetupEditController;
  readonly editorFor: typeof editorFor;
  readonly parseDraft: typeof parseDraft;
  /** Save one answer. Offline → queued; a stale version → conflict; a rule refusal → failed. */
  readonly save: (key: string, value: unknown, ifVersion: number) => Promise<SaveResult>;
  /** Re-read the whole setup status (so completeness recomputes after a save). */
  readonly reload: () => Promise<SetupStatus | null>;
  /** Re-present a fresh status through the tested screen model. */
  readonly present: (status: SetupStatus) => SetupSession;
}

// One idempotency key per field, minted once and reused across retries — so a resend after a lost
// reply cannot apply the same change twice (the key belongs to the decision, not the attempt).
const setupIdempotency = new Map<string, string>();

async function setupSave(key: string, value: unknown, ifVersion: number): Promise<SaveResult> {
  const idem = setupIdempotency.get(key)
    ?? (globalThis.crypto?.randomUUID?.() ?? `setup-${key}-${ifVersion}`);
  setupIdempotency.set(key, idem);
  try {
    const res = await fetch(`/v1/platform/setup/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': idem },
      body: JSON.stringify({ value, ifVersion }),
    });
    if (res.status < 400) {
      setupIdempotency.delete(key);
      const status = (await res.json()) as SetupStatus;
      const item = status.items.find((i) => i.key === key);
      return { kind: 'saved', version: item?.version ?? ifVersion + 1 };
    }
    if (res.status === 409) {
      setupIdempotency.delete(key);
      return { kind: 'conflict', currentVersion: ifVersion };
    }
    setupIdempotency.delete(key);
    const body = (await res.json().catch(() => ({}))) as { error?: { whatHappened?: string } };
    return saveResultFromError(res.status, ifVersion, body.error?.whatHappened ?? 'The change was refused.');
  } catch {
    // No line: keep the key so a retry reuses it, and report queued — nothing is lost.
    return { kind: 'queued' };
  }
}

async function setupReload(): Promise<SetupStatus | null> {
  try {
    const res = await fetch('/v1/platform/setup', { method: 'GET', headers: { accept: 'application/json' } });
    return res.status < 400 ? ((await res.json()) as SetupStatus) : null;
  } catch {
    return null;
  }
}

function makeSetupEditing(data: SetupData): SetupEditingApi {
  const config = { tenantId: data.storeId ?? 'tenant', userId: data.userId === undefined ? null : data.userId };
  return {
    controller: new SetupEditController(),
    editorFor,
    parseDraft,
    save: setupSave,
    reload: setupReload,
    present: (status) => createSetupSession(config, { status: () => status }),
  };
}

/** What the box tells the AI control screen. */
export interface AiData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly now?: string;
  readonly period?: string;
  readonly staleAfterMinutes?: number;
  readonly killSwitches?: readonly KillSwitch[];
  readonly agentBudgets?: readonly AgentBudget[];
  /**
   * Every metered call. **Absent means the box has never been told**, which is not no calls —
   * and it is the only source of what an agent has spent.
   */
  readonly usage?: readonly UsageEntry[];
  /** **Absent means the owner has never set a platform ceiling** (D3) — not a ceiling of nought. */
  readonly platformCeilingMinor?: number;
  readonly pending?: readonly PendingProposal[];
  /** **An agent missing here has never been evaluated**, which is not a score of nought. */
  readonly evaluations?: Readonly<Record<string, { readonly passed: number; readonly total: number; readonly at: string }>>;
}

export function aiPortsFromData(data: AiData | undefined): AiPorts {
  return {
    // An empty list here genuinely means "no switch has ever been pulled", which is the truth.
    switches: () => data?.killSwitches ?? [],
    // An agent with no budget row has no ceiling. `admitCall` refuses without one, and the screen
    // shows nothing rather than a comfortable-looking nought.
    budgets: () => data?.agentBudgets ?? [],
    // NOT defaulted. A substituted empty list says every agent has its whole ceiling still to
    // spend, which is the more expensive of the two guesses and reads as good news.
    usage: () => data?.usage,
    // NOT defaulted. No ceiling means the owner has never agreed one, and a summary built without
    // it reports every agent sitting comfortably inside a limit nobody set.
    platformCeilingMinor: () => data?.platformCeilingMinor,
    period: () => data?.period ?? '',
    pending: () => data?.pending ?? [],
    // NOT defaulted per agent. Absent means never evaluated.
    evaluations: () => data?.evaluations ?? {},
  };
}

/** Build the AI control screen, or `null` when the box was told nothing about the agents. */
export function bootAi(data: AiData | undefined): AiSession | null {
  if (data === undefined) return null;
  return createAiSession(
    {
      tenantId: data.storeId ?? 'tenant',
      // NOT defaulted. Stopping the AI, and committing anything it drafted, carries a name.
      userId: data.userId === undefined ? null : data.userId,
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      staleAfterMinutes: data.staleAfterMinutes ?? 60,
    },
    aiPortsFromData(data),
  );
}

/** What the box tells the migration screen. */
export interface MigrationData {
  readonly userId?: string;
  readonly storeId?: string;
  readonly now?: string;
  readonly cutoverId?: string;
  readonly requiredCleanDays?: number;
  readonly cutoverAccepted?: boolean;
  /** **Absent means nothing can be signed at all** (§28) — see `migration-session.ts`. */
  readonly loadOperator?: string;
  readonly sources?: readonly LegacySource[];
  /** **Never pruned.** A resolved exception is the evidence somebody looked at it (#6). */
  readonly exceptions?: readonly MigrationException[];
  readonly totals?: readonly ControlTotal[];
  readonly parallelDays?: readonly ParallelDayResult[];
  readonly parallelDifferences?: readonly ParallelDifference[];
  readonly exclusions?: readonly HistoryExclusion[];
  readonly archive?: LegacyArchive;
  /** From the box's own outbox. **Absent is not nought** — an unsynced till is an unmigrated sale. */
  readonly edgeUnsyncedItems?: number;
  readonly deltaAppliedAt?: string;
  /** When a rollback was **performed**. A designed one leaves this absent, deliberately. */
  readonly rollbackDemonstratedAt?: string;
  readonly namedTeam?: readonly TeamMember[];
  readonly ownerGoBy?: string;
  readonly openAssessments?: number;
}

/**
 * Ports over the migration payload.
 *
 * **Not one of these is defaulted**, and that is the whole fix. The eight-check cutover gate has
 * always been handed booleans somebody typed; a `?? []` on any line below would put it straight
 * back, because an empty exception list reads as clean data and an empty totals list reads as a
 * reconciliation with nothing wrong.
 */
export function migrationPortsFromData(data: MigrationData | undefined, outbox: SyncOutbox = new SyncOutbox()): MigrationPorts {
  return {
    sources: () => data?.sources,
    exceptions: () => data?.exceptions,
    totals: () => data?.totals,
    parallelDays: () => data?.parallelDays,
    parallelDifferences: () => data?.parallelDifferences,
    exclusions: () => data?.exclusions,
    archive: () => data?.archive,
    edgeUnsyncedItems: () => data?.edgeUnsyncedItems,
    deltaAppliedAt: () => data?.deltaAppliedAt,
    rollbackDemonstratedAt: () => data?.rollbackDemonstratedAt,
    namedTeam: () => data?.namedTeam,
    ownerGoBy: () => data?.ownerGoBy,
    openAssessments: () => data?.openAssessments,
    // A signature made on this page is committed here and queued (hard rule #1). The screen draws
    // the working copy, and the sync agent drains this to the cloud. A signature that lives only
    // in the tab is not a signature — which is exactly what the first version produced.
    outbox: () => outbox,
  };
}

/** Build the migration screen, or `null` when the box was told nothing about a cutover. */
export function bootMigration(data: MigrationData | undefined, outbox: SyncOutbox = new SyncOutbox()): MigrationSession | null {
  if (data === undefined) return null;
  return createMigrationSession(
    {
      tenantId: data.storeId ?? 'tenant',
      // NOT defaulted. Signing a figure, deciding about the old data and rolling back all carry
      // the name of whoever did them.
      userId: data.userId === undefined ? null : data.userId,
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      cutoverId: data.cutoverId ?? '',
      requiredCleanDays: data.requiredCleanDays ?? 0,
      // NOT defaulted. A separation of duties that cannot be checked is not a separation.
      loadOperator: data.loadOperator,
      cutoverAccepted: data.cutoverAccepted === true,
    },
    migrationPortsFromData(data, outbox),
  );
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface ManagerWindow {
  managerSession?: ManagerSession;
  managerData?: ManagerData;
  /**
   * The store computer's own write address (M14-FR-04), injected by the edge screen-server only when
   * this box serves a lane socket. The manager's day close posts here — cross-port on 127.0.0.1, not
   * same-origin — because the box owns the real outbox and the authoritative close. Absent means no
   * box: the screen falls back to a local preview close that only touches this browser.
   */
  laneWriteBase?: string;
  buyingSession?: BuyingSession;
  buyingData?: BuyingData;
  /** What the box did not tell the buyer's screen, so the screen can say it rather than guess. */
  buyingGaps?: readonly BuyingGap[];
  catalogueSession?: CatalogueSession;
  catalogueData?: CatalogueData;
  catalogueGaps?: readonly CatalogueGap[];
  catalogueOutbox?: SyncOutbox;
  merchandisingSession?: MerchandisingSession;
  merchandisingData?: MerchandisingData;
  merchandisingGaps?: readonly MerchandisingGap[];
  reportingSession?: ReportingSession;
  reportingData?: ReportingData;
  serviceData?: ServiceData;
  serviceSession?: ServiceSession;
  expiryData?: ExpiryData;
  expirySession?: ExpirySession;
  financeData?: FinanceData;
  financeSession?: FinanceSession;
  gstReconciliationData?: GstReconciliationData;
  gstReconciliationSession?: GstReconciliationSession;
  /** Where a portal action (poll/verify) queues for the sync agent to drain — device-backed, survives a reload. */
  gstReconciliationOutbox?: SyncOutbox;
  categoryPolicyData?: CategoryPolicyData;
  categoryPolicySession?: CategoryPolicySession;
  essData?: EssData;
  essSession?: EssSession;
  /** The shell reads my rota + payslip live through this and re-presents them — self-scoped GETs, never writes. */
  essLive?: {
    refresh(): Promise<{ roster: EssRoster | null; payslip: EssPayslip | null } | null>;
    present(data: { roster: EssRoster | null; payslip: EssPayslip | null }): EssSession;
  };
  gstReturnsData?: GstReturnsData;
  gstReturnsSession?: GstReturnsSession;
  /** Where a governance action (approve/submit) queues for the sync agent — device-backed, survives a reload. */
  gstReturnsOutbox?: SyncOutbox;
  wasteData?: WasteData;
  wasteSession?: WasteReviewSession;
  writeOffCaptureData?: WriteOffCaptureData;
  writeOffCaptureSession?: WriteOffCaptureSession;
  /** The injected write path the screen posts a loss through — the raiser's own session, never a service token. */
  writeOffCapture?: {
    capturePort(): WriteOffCapturePort;
  };
  countsData?: CountsData;
  countsSession?: CountsReviewSession;
  dataQualityInboxData?: DataQualityInboxData;
  dataQualityInboxSession?: DataQualityInboxSession;
  /** The shell reads the live worklist through this and re-presents it — a GET read, never a write. */
  dataQualityInbox?: {
    refresh(): Promise<DataQualityWorklistData | null>;
    present(worklist: DataQualityWorklistData): DataQualityInboxSession;
  };
  operationsInboxData?: OperationsInboxData;
  operationsInboxSession?: OperationsInboxSession;
  /** The shell reads the live worklist through this and re-presents it — a GET read, never a write. */
  operationsInbox?: {
    refresh(): Promise<OperationsWorklistData | null>;
    present(worklist: OperationsWorklistData): OperationsInboxSession;
  };
  returnGovernanceData?: ReturnGovernanceData;
  returnGovernanceSession?: ReturnGovernanceSession;
  /** The shell reads the live refund exceptions through this and re-presents them — a GET read, never a write. */
  returnGovernance?: {
    refresh(): Promise<ReturnGovernanceExceptions | null>;
    present(exceptions: ReturnGovernanceExceptions): ReturnGovernanceSession;
  };
  lossPreventionInboxData?: LossPreventionInboxData;
  lossPreventionInboxSession?: LpInboxSession;
  /** The shell reads the live open-cases worklist through this and re-presents it — a GET read, never a write. */
  lossPreventionInbox?: {
    refresh(): Promise<LpWorklistData | null>;
    present(worklist: LpWorklistData): LpInboxSession;
  };
  rosteringData?: RosteringScreenData;
  rosteringSession?: RosteringSession;
  /** The shell reads the live roster worklist through this and re-presents it — GET reads, never a write. */
  rostering?: {
    refresh(): Promise<RosteringData | null>;
    present(worklist: RosteringData): RosteringSession;
  };
  checklistData?: ChecklistScreenData;
  checklistSession?: ChecklistSession;
  /** The shell reads the live checklist worklist through this and re-presents it — a GET read, never a write. */
  checklist?: {
    refresh(): Promise<ChecklistData | null>;
    present(worklist: ChecklistData): ChecklistSession;
  };
  productionData?: ProductionScreenData;
  productionSession?: ProductionSession;
  /** The shell reads the live production board through this and re-presents it — a GET read, never a write. */
  production?: {
    refresh(): Promise<ProductionData | null>;
    present(worklist: ProductionData): ProductionSession;
  };
  facilitiesData?: FacilitiesScreenData;
  facilitiesSession?: FacilitiesSession;
  /** The shell reads the live overdue board through this and re-presents it — a GET read, never a write. */
  facilities?: {
    refresh(): Promise<FacilitiesData | null>;
    present(worklist: FacilitiesData): FacilitiesSession;
  };
  cashOfficeData?: CashOfficeData;
  cashOfficeSession?: CashOfficeSession;
  /** The shell reads the live over/short worklist through this and re-presents it — a GET read, never a write. */
  cashOffice?: {
    refresh(): Promise<CashOverShortData | null>;
    present(worklist: CashOverShortData): CashOfficeSession;
  };
  riskAcceptanceData?: RiskAcceptanceData;
  riskAcceptanceSession?: RiskAcceptanceSession;
  /** The shell reads the live blocked-gates worklist through this and re-presents it — a GET read, never a write. */
  riskAcceptance?: {
    refresh(): Promise<BlockedGatesData | null>;
    present(worklist: BlockedGatesData): RiskAcceptanceSession;
  };
  dayReopenData?: DayReopenScreenData;
  dayReopenSession?: DayReopenSession;
  /** The shell reads the live locked-day worklist through this and re-presents it — a GET read; the reopen
   *  action itself posts to the box (cross-port), never the cloud. */
  dayReopen?: {
    refresh(): Promise<DayReopenData | null>;
    present(worklist: DayReopenData): DayReopenSession;
  };
  stockHealthData?: StockHealthScreenData;
  stockHealthSession?: StockHealthSession;
  /** The shell reads the live stock-health figures through this and re-presents them — GET reads, never writes. */
  stockHealth?: {
    refresh(): Promise<StockHealthData | null>;
    present(snapshot: StockHealthData): StockHealthSession;
  };
  storedValueData?: StoredValueScreenData;
  storedValueSession?: StoredValueOversightSession;
  /** The shell reads the three stored-value oversight feeds through this and re-presents them — GETs, never
   *  writes: refresh() the store-wide velocity watch, reconcile() the liability vs a posted figure, lookup() one
   *  household's double-spends. Each returns the merged data (or null offline), which present() renders. */
  storedValue?: {
    refresh(): Promise<StoredValueOversightData | null>;
    reconcile(postedMinor: number): Promise<StoredValueOversightData | null>;
    lookup(ownerRef: string): Promise<StoredValueOversightData | null>;
    present(data: StoredValueOversightData): StoredValueOversightSession;
  };
  integrationHealthData?: IntegrationHealthScreenData;
  integrationHealthSession?: IntegrationHealthSession;
  /** The shell reads the live integration-health picture through this and re-presents it — a GET read, never a
   *  write: refresh() the adapter health picture, which present() renders. */
  integrationHealth?: {
    refresh(): Promise<IntegrationHealthData | null>;
    present(data: IntegrationHealthData): IntegrationHealthSession;
  };
  goodsReceiptData?: GoodsReceiptScreenData;
  goodsReceiptSession?: GoodsReceiptSession;
  /** The shell reads the live GRN list through this and re-presents it — a GET read, never a write. */
  goodsReceipt?: {
    refresh(): Promise<GoodsReceiptData | null>;
    present(snapshot: GoodsReceiptData): GoodsReceiptSession;
  };
  dataIoData?: DataIoData;
  dataIoSession?: DataIoSession;
  /** The shell reads the live export catalogue + log through this and re-presents it — GET reads, never writes. */
  dataIo?: {
    refresh(): Promise<DataIoLive | null>;
    present(live: DataIoLive): DataIoSession;
  };
  workforceInboxData?: WorkforceInboxData;
  workforceInboxSession?: WorkforceInboxSession;
  /** The shell reads the live worklist through this and re-presents it — a GET read, never a write. */
  workforceInbox?: {
    refresh(): Promise<WorkforceWorklistData | null>;
    present(worklist: WorkforceWorklistData): WorkforceInboxSession;
  };
  fleetData?: FleetData;
  fleetSession?: FleetSession;
  /** Where a device change (register/block/retire) queues for the sync agent — device-backed, survives a reload. */
  fleetOutbox?: SyncOutbox;
  productPublishReviewData?: ProductPublishReviewData;
  productPublishReviewSession?: ProductPublishReviewSession;
  /** The device-backed catalogue outbox the review screen reads and, on the deliver action, drains — the SAME
   *  queue the catalogue Save commits publishes to. */
  productPublishReviewOutbox?: SyncOutbox;
  payrollData?: PayrollData;
  payrollSession?: PayrollSession;
  payrollEssData?: PayrollEssData;
  payrollEssSession?: PayrollEssSession;
  /** The shell calls this after a successful MFA step to refresh the sensitive-action re-auth window. */
  payrollReauth?: () => void;
  adminData?: AdminData;
  adminSession?: AdminSession;
  setupData?: SetupData;
  setupSession?: SetupSession;
  setupEditing?: SetupEditingApi;
  aiData?: AiData;
  aiSession?: AiSession;
  migrationData?: MigrationData;
  migrationSession?: MigrationSession;
  warehouseSupervisorData?: SupervisorData;
  warehouseSupervisorSession?: WarehouseSupervisorSession;
  /** Where the supervisor's approval decisions queue for sync — the view passes it to `decide`. */
  warehouseSupervisorOutbox?: SyncOutbox;
  /** The decision vocabulary, so the view can offer it and never invent a reason of its own. */
  managerReasons?: {
    readonly approved: readonly DecisionReasonCode[];
    readonly rejected: readonly DecisionReasonCode[];
  };
}

/** Why a register says nothing when the payload did not carry it. */
const NOT_CONNECTED = 'this screen has not received that list from the store yet';

/**
 * Ports over a last-synced payload.
 *
 * Each register is present only if the payload actually carried it. A missing key is **not** an
 * empty list: the two are different facts and the difference is what stops a day closing on a page
 * that was never told anything.
 */
export function portsFromData(data: ManagerData | undefined): ManagerPorts {
  if (data === undefined) return disconnectedPorts(NOT_CONNECTED);

  const register = (items: readonly RegisterItem[] | undefined): Register =>
    items === undefined ? notKnown(NOT_CONNECTED) : { known: true, items };
  const approvals = (): ApprovalRegister =>
    data.approvals === undefined ? notKnown(NOT_CONNECTED) : { known: true, requests: data.approvals };

  // A product this screen was never told about is not a product worth nothing. Refusing the count
  // is the only honest answer, and it is what keeps a shrinkage above somebody's approval limit.
  const productValue = (productId: string): ValueRegister => {
    const fact = data.products?.find((p) => p.id === productId);
    if (fact === undefined) {
      return notKnown(`this screen has not been told what "${productId}" is worth`);
    }
    return { known: true, valuePerUnitMinor: fact.valuePerUnitMinor };
  };

  return {
    approvals,
    openExceptions: () => register(data.openExceptions),
    unsentItems: () => register(data.unsentItems),
    tasks: () => register(data.tasks),
    productValue,
  };
}

/**
 * The manager's day-close write to the STORE COMPUTER (M14-FR-04) — the one write this screen makes.
 *
 * It is a CROSS-PORT POST on 127.0.0.1, not same-origin: the box serves the manager screen on one
 * loopback port and listens for writes (the lane socket) on another. `laneWriteBase` names the lane;
 * the edge screen-server injects it only when this box actually serves one. The box owns the real
 * outbox and makes the authoritative close decision — this function carries the ask and reports back
 * exactly what the box decided, and turns a dropped link into a refusal-with-reason (P-08), never a
 * false "closed".
 *
 * `undefined` when no `laneWriteBase` was injected: there is no box to post to, so the manager session
 * is built without this port, `canCloseViaBox` is false, and the local preview close is used instead.
 */
export function openDayClosePort(
  laneWriteBase: string | undefined,
): ManagerPorts['requestDayClose'] {
  if (laneWriteBase === undefined) return undefined;
  return async ({ dayCloseId, closedBy }): Promise<BoxCloseOutcome> => {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (fetchFn === undefined) {
      return { closed: false, reason: 'this screen cannot reach the store computer from here — the day is not closed' };
    }
    try {
      const res = await fetchFn(`${laneWriteBase}/lane/day-close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ dayCloseId, closedBy }),
      });
      const body = (await res.json().catch(() => ({}))) as { closed?: boolean; tradingDay?: string; reason?: string };
      if (res.status >= 200 && res.status < 300 && body.closed === true && typeof body.tradingDay === 'string') {
        return { closed: true, tradingDay: body.tradingDay };
      }
      // Anything else is the box declining to close — surface its own reason rather than a bare "no".
      return { closed: false, reason: body.reason ?? 'the store computer did not close the day' };
    } catch {
      // A network/timeout is a lost link, not a lock. The day stays open and the screen says why.
      return { closed: false, reason: 'the store computer could not be reached — the day is not closed' };
    }
  };
}

/**
 * Build the manager's session from this store's configuration.
 *
 * Every value here is per-tenant (ADR-0003) — the trading-day cut-off, the approval limit, the
 * count threshold, the warehouse. The defaults let the shell run standalone; a deployment passes
 * the tenant's signed config pack.
 */
export function bootManager(config?: {
  storeId?: string;
  branchId?: string | null;
  tradingDay?: string;
  /** Where this store's trading day ends, as "HH:MM" local. */
  tradingDayCutoff?: string;
  managerId?: string;
  /** Maximum value this manager may approve, in minor units; null = unlimited. */
  approvalLimitMinor?: number | null;
  warehouseId?: string;
  countApprovalThresholdMinor?: number;
  data?: ManagerData;
  /** The box's lane write address (M14-FR-04). Present = the day close goes to the store computer. */
  laneWriteBase?: string;
}): ManagerSession {
  // `??` would be wrong here and was: an explicit `null` means *company-wide*, and `null ?? 'store-1'`
  // quietly demoted a company-wide manager to one branch — where their own scope then blocked them
  // from deciding anything outside it. Only `undefined` means "not configured".
  const branchId = config?.branchId === undefined ? 'store-1' : config.branchId;
  const limit = config?.approvalLimitMinor;
  const requestDayClose = openDayClosePort(config?.laneWriteBase);
  return createManagerSession(
    {
      storeId: config?.storeId ?? 'store-1',
      branchId,
      tradingDay: config?.tradingDay ?? '1970-01-01',
      tradingDayRule: makeTradingDayRule(config?.tradingDayCutoff ?? '00:00'),
      manager: {
        userId: config?.managerId ?? 'manager',
        branchScope: branchId === null ? 'all' : [branchId],
        authorityLimit: limit === undefined || limit === null ? null : { minor: limit, currency: 'INR' },
      },
      currency: 'INR',
      warehouseId: config?.warehouseId ?? 'store-1',
      countApprovalThresholdMinor: config?.countApprovalThresholdMinor ?? 100_000,
    },
    // The read registers come from the last-synced payload; the one WRITE port (day close) is added
    // only when this box serves a lane to post to. `??` on the whole port keeps a missing box honest.
    { ...portsFromData(config?.data), ...(requestDayClose === undefined ? {} : { requestDayClose }) },
    new Ledger(new InMemoryLedgerStore()),
    new SyncOutbox(),
  );
}

/**
 * Something this screen was never told, named so it can be said on the page.
 *
 * Every one of these fails toward a **refusal** rather than a false all-clear — an unknown product
 * list rejects every line, an unknown order set makes every invoiced line look unordered, an
 * unknown invoice set makes the match refuse outright. That is the safe direction, and it is still
 * not good enough on its own: a buyer looking at "this was never ordered" cannot tell a supplier
 * who invoiced for goods nobody asked for from a box that was simply never sent the order. The
 * screen has to say which (P-08).
 */
export const BUYING_GAPS = Object.freeze([
  'what_this_shop_stocks',
  'what_was_ordered',
  'what_arrived',
  'which_invoices_are_already_saved',
  'who_may_approve',
] as const);
export type BuyingGap = (typeof BUYING_GAPS)[number];

/** Everything the buyer's screen was not given. Empty means it was told all of it. */
export function buyingGaps(data: BuyingData | undefined): readonly BuyingGap[] {
  const gaps: BuyingGap[] = [];
  if (data?.productIds === undefined) gaps.push('what_this_shop_stocks');
  if (data?.ordered === undefined) gaps.push('what_was_ordered');
  if (data?.received === undefined) gaps.push('what_arrived');
  if (data?.captured === undefined) gaps.push('which_invoices_are_already_saved');
  // An empty list counts as a gap here, and deliberately: nobody to approve is indistinguishable in
  // effect from never having been told, because both leave the buyer unable to save anything.
  if (data?.approvers === undefined || data.approvers.length === 0) gaps.push('who_may_approve');
  return gaps;
}

/**
 * Ports over what the buyer's screen was told.
 *
 * A purchase order this box has never heard of contributes **nothing** rather than an invented
 * empty order — and an empty ordered set against a real invoice would make the three-way match
 * compare an invoice with a delivery that did not happen. The buying session's own `match` already
 * refuses when no invoice has been captured; this must not undo that from the other side.
 *
 * The empty answers here are therefore load-bearing refusals, not tidy defaults, and every one of
 * them is reported by `buyingGaps` so the screen can name it.
 */
/**
 * The authenticated POST that PROPOSES a purchase order at head office (M06-FR-02, API-03). One call under the
 * buyer's OWN session (`credentials: 'same-origin'`, never a service token) to `POST /v1/purchase/orders/:poId`:
 * the cloud attributes the requisitioner to the authenticated caller and keeps the PO event-sourced. The PO id is
 * the idempotency key, so a re-click of "raise" for the same order collapses to one PO — never a duplicate order
 * to a supplier. The proposal carries no approver: issuing is a separate second-person §28 act (the `/approval`
 * route), never something this screen does. A 2xx carrying the proposed order is the saved proposal; any other
 * status is the cloud declining (surfaced, never a false "raised"); a dropped link is a lost link, not an order (P-08).
 */
export function openProposePurchaseOrderPort(): ProposePurchaseOrderPort {
  return {
    post: async ({ poId, supplierId, lines }): Promise<ProposePurchaseOrderOutcome> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return { proposed: false, reason: 'no connection to head office — the order was not raised' };
      try {
        const res = await fetchFn(`/v1/purchase/orders/${encodeURIComponent(poId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': poId, accept: 'application/json' },
          credentials: 'same-origin',
          // The Money-shaped lines are exactly what the route reads ({ productId, orderedQty, unitCost: { minor, currency } });
          // the requisitioner is the authenticated caller, so no buyer name is sent, and no approver rides along.
          body: JSON.stringify({ supplierId, lines }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          order?: { requisitionedBy?: string; totalMinor?: number };
          whatHappened?: string;
        };
        if (
          res.status >= 200 && res.status < 300 &&
          body.order !== undefined &&
          typeof body.order.requisitionedBy === 'string' &&
          typeof body.order.totalMinor === 'number'
        ) {
          return { proposed: true, requisitionedBy: body.order.requisitionedBy, totalMinor: body.order.totalMinor };
        }
        return { proposed: false, reason: body.whatHappened ?? 'head office did not raise the order' };
      } catch {
        return { proposed: false, reason: 'no connection to head office — the order was not raised' };
      }
    },
  };
}

export function buyingPortsFromData(data: BuyingData | undefined, proposeOrder?: ProposePurchaseOrderPort): BuyingPorts {
  return {
    knownProductIds: () => data?.productIds ?? [],
    orderedLines: (poId) => data?.ordered?.[poId] ?? [],
    receivedLines: (poId) => data?.received?.[poId] ?? [],
    capturedLines: (invoiceId) => data?.captured?.[invoiceId] ?? [],
    // Only when a real cloud port was passed at mount: an offline box (or a test with none) keeps its
    // local compute and `canProposeToCloud` reads false, so the screen never offers to raise an order
    // it cannot actually send (P-01/P-08).
    ...(proposeOrder === undefined ? {} : { proposeOrder: () => proposeOrder }),
  };
}

/** Build the buyer's session, or `null` when this box was told nothing about buying. */
export function bootBuying(data: BuyingData | undefined, proposeOrder?: ProposePurchaseOrderPort): BuyingSession | null {
  if (data === undefined) return null;
  return createBuyingSession(
    {
      tenantId: 'tenant',
      buyerId: data.buyerId ?? 'buyer',
      currency: 'INR',
      // Defaults matching `threeWayMatch`'s own: no quantity tolerance, 1% on price, ₹1 immaterial.
      quantityToleranceBps: data.quantityToleranceBps ?? 0,
      priceToleranceBps: data.priceToleranceBps ?? 100,
      immaterialMinor: data.immaterialMinor ?? 100,
    },
    buyingPortsFromData(data, proposeOrder),
  );
}

/**
 * Something the product-and-pricing screen was never told.
 *
 * These do NOT all fail the same way, which is why each is named rather than rolled into one
 * "not connected" message:
 *
 *   • no departments and nothing can be **scored at all** — the screen says *not knowable*
 *     rather than 0%, because a zero would send somebody to fix a finished record;
 *   • no costs and no **margin** can be checked, so every price change needs an approver;
 *   • no barcodes and a clash cannot be spotted, so one scan could ring up two products;
 *   • nobody to approve and nothing that needs approval can go through at all.
 */
export const CATALOGUE_GAPS = Object.freeze([
  'what_the_shop_sells',
  'what_each_department_needs',
  'what_things_cost',
  'the_prices_already_set',
  'which_barcodes_are_taken',
  'who_may_approve',
  'where_things_sit_on_the_shelves',
  'which_zones_to_collect_last',
] as const);
export type CatalogueGap = (typeof CATALOGUE_GAPS)[number];

/** Everything the product-and-pricing screen was not given. Empty means it was told all of it. */
export function catalogueGaps(data: CatalogueData | undefined): readonly CatalogueGap[] {
  const gaps: CatalogueGap[] = [];
  if (data?.products === undefined) gaps.push('what_the_shop_sells');
  if (data?.categories === undefined) gaps.push('what_each_department_needs');
  if (data?.costsMinor === undefined) gaps.push('what_things_cost');
  if (data?.priceEntries === undefined) gaps.push('the_prices_already_set');
  if (data?.barcodes === undefined) gaps.push('which_barcodes_are_taken');
  // An empty list counts, and deliberately: nobody to approve stops exactly the same work as
  // never having been told who may.
  if (data?.approvers === undefined || data.approvers.length === 0) gaps.push('who_may_approve');
  if (data?.shelfLocations === undefined) gaps.push('where_things_sit_on_the_shelves');
  // Only worth saying once the shop HAS shelves. Asking a shop with no shelf map which zones it
  // collects last is asking about a walk that does not exist yet.
  else if (data.zoneOrder === undefined) gaps.push('which_zones_to_collect_last');
  return gaps;
}

/**
 * Ports over what the product-and-pricing screen was told.
 *
 * The empty answers here are load-bearing refusals rather than tidy defaults, and every one is
 * reported by `catalogueGaps` so the screen can name it. The cost port is the important one: it
 * answers **not known** rather than zero, because a cost of zero makes every price look like a
 * 100% margin and the floor check then passes, confidently and wrongly, at the moment a buyer is
 * relying on it.
 */
/**
 * The authenticated POST that records a promotion launch at head office (M05-FR-03/04, API-02). One
 * operator-authenticated call under their OWN session (`credentials: 'same-origin'`, never a service token) to
 * `POST /v1/promotions/:id/launch`: the cloud re-simulates the input and re-checks §28 (a margin-losing offer
 * needs a different, authorised approver). A 2xx `launched` is a launch; a 422 is the cloud refusing (surfaced,
 * never a false "launched"); a dropped link is a lost link, not a launch (P-08).
 */
export function openPromotionLaunchPort(): PromotionLaunchPort {
  return {
    post: async ({ input, approval }): Promise<PromotionLaunchOutcome> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return { launched: false, reason: 'no connection to head office — the offer was not launched' };
      const key = globalThis.crypto?.randomUUID?.() ?? `promotion-launch-${input.promotionId}`;
      try {
        const res = await fetchFn(`/v1/promotions/${encodeURIComponent(input.promotionId)}/launch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          // The cloud reads the simulation input from the body and re-runs it; the §28 approver + reason ride
          // alongside for a margin-losing offer. A name typed in a box is not authority — the cloud verifies it.
          body: JSON.stringify({ ...input, ...(approval === undefined ? {} : { approvedBy: approval.approvedBy, rationale: approval.rationale }) }),
        });
        const body = (await res.json().catch(() => ({}))) as { launched?: boolean; verdict?: string; approvedBy?: string | null; whatHappened?: string };
        if (res.status >= 200 && res.status < 300 && body.launched === true) {
          return { launched: true, verdict: body.verdict ?? 'launched', approvedBy: body.approvedBy ?? null };
        }
        // 422 (needs approval / approver may not approve) or any other non-2xx — the cloud declined; surface why.
        return { launched: false, reason: body.whatHappened ?? 'head office did not launch the offer' };
      } catch {
        return { launched: false, reason: 'no connection to head office — the offer was not launched' };
      }
    },
  };
}

/**
 * The authenticated POST that records a governed price change at head office (M05-FR-02, API-02). One
 * operator-authenticated call under their OWN session (`credentials: 'same-origin'`, never a service token) to
 * `POST /v1/prices/changes`: the cloud re-runs `checkPrice` over the figures (MRP ceiling, cost, margin floor)
 * and re-checks §28 (a below-cost/below-floor price needs a different, authorised approver). A 2xx carrying a
 * verdict is the recorded change; a 422 is the cloud refusing (surfaced, never a false "saved"); a dropped link
 * is a lost link, not a change (P-08).
 */
export function openPriceChangePort(): PriceChangeCloudPort {
  return {
    post: async ({ productId, priceMinor, mrpMinor, costMinor, currency, marginFloorBps, approval }): Promise<PriceChangeCloudOutcome> => {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (fetchFn === undefined) return { saved: false, reason: 'no connection to head office — the price was not changed' };
      const key = globalThis.crypto?.randomUUID?.() ?? `price-change-${productId}-${priceMinor}`;
      try {
        const res = await fetchFn('/v1/prices/changes', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
          credentials: 'same-origin',
          // The cloud re-runs the guard over these raw figures; the §28 approver + reason ride alongside for a
          // below-cost/below-floor price. A name typed in a box is not authority — the cloud verifies it holds
          // `price.change.approve` and is not the setter.
          body: JSON.stringify({
            productId, priceMinor, mrpMinor, costMinor, currency, marginFloorBps,
            ...(approval === undefined ? {} : { approval: { decidedBy: approval.approvedBy, reason: approval.rationale } }),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { verdict?: string; approvedBy?: string | null; whatHappened?: string };
        if (res.status >= 200 && res.status < 300 && typeof body.verdict === 'string') {
          return { saved: true, verdict: body.verdict, approvedBy: body.approvedBy ?? null };
        }
        // 422 (above MRP / below cost / below floor without a valid approver) or any other non-2xx — surface why.
        return { saved: false, reason: body.whatHappened ?? 'head office did not change the price' };
      } catch {
        return { saved: false, reason: 'no connection to head office — the price was not changed' };
      }
    },
  };
}

/**
 * The authenticated POST that records a recall's start and closure at head office as a DURABLE,
 * CENTRAL record (M10-FR-04, API-04, hard rule #6). One operator-authenticated call under their OWN
 * session (`credentials: 'same-origin'`, never a service token) to `POST /v1/quality/recalls/:batchId`
 * (initiate) and `.../closure` (close): the cloud gates it on `quality.recall.initiate`, keeps the
 * lifecycle event-sourced and never deletes a closed record. A 2xx carrying the recall is the saved
 * record (initiate returns it on both a new 201 and an already-open 200); a 4xx is the cloud declining
 * (surfaced, never a false "done"); a dropped link is a lost link, not a recall (P-08).
 *
 * The recall BLOCK that stops the till travels on the signed pack and is a separate mechanism; this
 * is only the record.
 */
export function openRecallCloudPort(): RecallCloudPort {
  const send = async (path: string, body: unknown, lostLink: string): Promise<RecallCloudResult> => {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (fetchFn === undefined) return { recorded: false, reason: lostLink };
    const key = globalThis.crypto?.randomUUID?.() ?? `recall-${Date.now()}`;
    try {
      const res = await fetchFn(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const parsed = (await res.json().catch(() => ({}))) as { recall?: unknown; alreadyOpen?: boolean; whatHappened?: string };
      if (res.status >= 200 && res.status < 300 && parsed.recall !== undefined) {
        return { recorded: true, alreadyOpen: parsed.alreadyOpen === true };
      }
      // 400/403/409/422 or any other non-2xx — head office declined; surface exactly why it said no.
      return { recorded: false, reason: parsed.whatHappened ?? 'head office did not record the recall' };
    } catch {
      return { recorded: false, reason: lostLink };
    }
  };
  return {
    initiate: ({ batchId, reason }) =>
      send(`/v1/quality/recalls/${encodeURIComponent(batchId)}`, { reason },
        'no connection to head office — the recall was not recorded'),
    close: ({ batchId, evidenceRef }) =>
      send(`/v1/quality/recalls/${encodeURIComponent(batchId)}/closure`, { evidenceRef },
        'no connection to head office — the closure was not recorded'),
  };
}

export function cataloguePortsFromData(data: CatalogueData | undefined, outbox?: SyncOutbox, launchPromotion?: PromotionLaunchPort, changePrice?: PriceChangeCloudPort): CataloguePorts {
  const costOf = (productId: string): CostRegister => {
    const minor = data?.costsMinor?.[productId];
    if (minor === undefined) {
      return {
        known: false,
        why: `this screen has not been told what "${productId}" cost us, so its margin cannot be worked out`,
      };
    }
    return { known: true, cost: { minor, currency: 'INR' } };
  };

  // Built once and kept: `ShelfMap` accumulates assignments, so rebuilding it per call would
  // throw away anything assigned on this screen the moment the list was re-rendered.
  const locations = data?.shelfLocations;
  let map: ShelfMap | null = null;
  if (locations !== undefined) {
    map = new ShelfMap(data?.storeId ?? 'store-1', locations, [], data?.zoneOrder);
    for (const assignment of data?.shelfAssignments ?? []) {
      // One bad row must not take the whole map down: refusing everything would report every
      // product in the shop as unmapped, which reads as the shelf data having been lost.
      try {
        map.assign(assignment);
      } catch {
        continue;
      }
    }
  }

  return {
    categories: () => data?.categories ?? [],
    products: () => data?.products ?? [],
    priceEntries: () => data?.priceEntries ?? [],
    costOf,
    barcodesInUse: () => data?.barcodes ?? [],
    promotions: () => data?.promotions ?? [],
    shelfMap: () => map,
    ...(outbox === undefined ? {} : { outbox: () => outbox }),
    ...(launchPromotion === undefined ? {} : { launchPromotion: () => launchPromotion }),
    ...(changePrice === undefined ? {} : { changePrice: () => changePrice }),
  };
}

/** Build the product-and-pricing session, or `null` when this box was told nothing about it. The outbox, when
 *  given, is the durable queue the Save button commits a publish to. */
export function bootCatalogue(data: CatalogueData | undefined, outbox?: SyncOutbox, launchPromotion?: PromotionLaunchPort, changePrice?: PriceChangeCloudPort): CatalogueSession | null {
  if (data === undefined) return null;
  return createCatalogueSession(
    {
      tenantId: 'tenant',
      storeId: data.storeId ?? 'store-1',
      userId: data.userId ?? 'pricing',
      currency: 'INR',
      // No clock in here. A screen that read its own would price against the device's date, and a
      // till whose clock is a day out would then activate tomorrow's price today.
      today: data.today ?? '1970-01-01',
      marginFloorBps: data.marginFloorBps ?? 0,
    },
    cataloguePortsFromData(data, outbox, launchPromotion, changePrice),
  );
}

/**
 * Something the merchandising screen was never told.
 *
 * These do not fail the same way, which is why each is named:
 *
 *   • no shelf map and nothing can be counted at all — a count against a shelf that does not
 *     exist is a count nobody can act on;
 *   • no planogram and there is nothing to compare a shelf against;
 *   • no stockroom figures and every refill task would be a wish rather than an instruction;
 *   • no square footage and "sales per square foot" would be a made-up number that decides a
 *     layout.
 */
export const MERCHANDISING_GAPS = Object.freeze([
  'where_the_shelves_are',
  'what_should_be_on_each_shelf',
  'what_is_in_the_stockroom',
  'what_this_shop_carries',
  'how_big_each_part_of_the_floor_is',
] as const);
export type MerchandisingGap = (typeof MERCHANDISING_GAPS)[number];

/** Everything the merchandising screen was not given. Empty means it was told all of it. */
export function merchandisingGaps(data: MerchandisingData | undefined): readonly MerchandisingGap[] {
  const gaps: MerchandisingGap[] = [];
  if (data?.shelfLocations === undefined) gaps.push('where_the_shelves_are');
  if (data?.planogram === undefined || data.planogram === null) gaps.push('what_should_be_on_each_shelf');
  if (data?.backstock === undefined) gaps.push('what_is_in_the_stockroom');
  if (data?.assortment === undefined) gaps.push('what_this_shop_carries');
  if (data?.spaceAreas === undefined) gaps.push('how_big_each_part_of_the_floor_is');
  return gaps;
}

/**
 * Ports over what the merchandising screen was told.
 *
 * The empty answers are load-bearing refusals rather than tidy defaults, and each is named by
 * `merchandisingGaps`. The two that matter most: an absent planogram makes `check()` refuse
 * outright rather than report a clean shop, and an absent stockroom figure makes every refill a
 * task for stock that may not exist — so it is reported, never assumed.
 */
export function merchandisingPortsFromData(data: MerchandisingData | undefined): MerchandisingPorts {
  const storeId = data?.storeId ?? 'store-1';

  // Built once and kept, so anything assigned or counted on this screen survives a re-render.
  const locations = data?.shelfLocations;
  let map: ShelfMap | null = null;
  if (locations !== undefined) {
    map = new ShelfMap(storeId, locations, []);
    for (const assignment of data?.shelfAssignments ?? []) {
      try {
        map.assign(assignment);
      } catch {
        continue;
      }
    }
  }

  const assortment = new Assortment(storeId, data?.assortment ?? []);
  const asMoney = (source: Readonly<Record<string, number>> | undefined): Record<string, Money> => {
    const out: Record<string, Money> = {};
    for (const [key, minor] of Object.entries(source ?? {})) out[key] = { minor, currency: 'INR' };
    return out;
  };

  return {
    shelfMap: () => map,
    planogram: () => data?.planogram ?? null,
    shelfCounts: () => data?.shelfCounts ?? [],
    backstock: () => data?.backstock ?? {},
    assortment: () => assortment,
    soldProductIds: () => data?.soldProductIds ?? [],
    onHand: () => data?.onHand ?? {},
    spaceAreas: () => data?.spaceAreas ?? [],
    salesByArea: () => asMoney(data?.salesByAreaMinor),
    marginByArea: () => asMoney(data?.marginByAreaMinor),
    displayContracts: () => data?.displayContracts ?? [],
    fundingReceived: () => asMoney(data?.fundingReceivedMinor),
    stillOccupying: () => data?.stillOccupying ?? [],
  };
}

/** Build the merchandising session, or `null` when this box was told nothing about it. */
export function bootMerchandising(data: MerchandisingData | undefined): MerchandisingSession | null {
  if (data === undefined) return null;
  return createMerchandisingSession(
    {
      tenantId: 'tenant',
      storeId: data.storeId ?? 'store-1',
      userId: data.userId ?? 'merchandiser',
      currency: 'INR',
      today: data.today ?? '1970-01-01',
      // No clock in the screen. A device whose date is a day out would otherwise judge every count
      // as stale — or, worse, judge a three-day-old one as fresh.
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      refillAtBp: data.refillAtBp ?? 5_000,
      countStaleAfterMinutes: data.countStaleAfterMinutes ?? 120,
      refillRole: data.refillRole ?? 'shelf-filler',
    },
    merchandisingPortsFromData(data),
  );
}

/**
 * Ports over what the reporting screen was told.
 *
 * **`records` defaults to nothing, and that is the honest default.** A screen handed no list of
 * what the shop records reports that it can run nothing at all and names every missing fact —
 * rather than offering every report and returning zeroes, which is the one outcome this whole
 * surface exists to prevent.
 *
 * The access control is built from the shop's own roles. Absent, it is an empty controller, which
 * is default-deny: no export leaves a box that has not been told who is allowed to take one.
 */
export function reportingPortsFromData(data: ReportingData | undefined): ReportingPorts {
  const access = new AccessControl(data?.roles ?? [], data?.roleAssignments ?? []);
  return {
    access: () => access,
    records: () => data?.records ?? [],
    sales: () => data?.sales ?? [],
    lastSyncedAt: () => data?.lastSyncedAt ?? null,
    unsentCount: () => data?.unsentCount ?? 0,
    exceptions: () => data?.exceptions ?? [],
    // Absent means NOT KNOWN, and not-known must not read as "the rules were checked and nothing
    // was wrong". Zero exceptions with no rules is a shop nobody is watching.
    exceptionRulesKnown: () => data?.exceptionRulesKnown === true,
    // Only the days the box genuinely holds. Absent is absent: a comparison against a day that is
    // not there would report the shop as having doubled overnight against a nought nobody put in.
    dayTotals: () => data?.dayTotals ?? [],
    unitsByCategory: () => data?.unitsByCategory ?? {},
    unitsWithNoCategory: () => data?.unitsWithNoCategory ?? 0,
    // NOT defaulted to `{}`. An empty name map and no name map read the same to a lookup, but the
    // report needs to know the difference: with no map it shows department ids and says so.
    categoryNames: () => data?.categoryNames,
  };
}

/** Build the reporting session, or `null` when this box was told nothing about reporting. */
export function bootReporting(data: ReportingData | undefined): ReportingSession | null {
  if (data === undefined) return null;
  return createReportingSession(
    {
      tenantId: 'tenant',
      storeId: data.storeId ?? 'store-1',
      // NOT defaulted. A made-up id would go into the audit record of every file written out,
      // and that record is the only evidence afterwards of who took the data. Absent means the
      // export refuses and says so, rather than denying under a name nobody holds.
      userId: data.userId === undefined ? null : data.userId,
      currency: 'INR',
      // No clock in the screen. A number is judged fresh or stale against the SHOP's clock, and a
      // device an hour out would quietly relabel a stale figure as live.
      now: data.now ?? '1970-01-01T00:00:00.000Z',
      laggingAfterMinutes: data.laggingAfterMinutes ?? 5,
      staleAfterMinutes: data.staleAfterMinutes ?? 60,
      branchId: data.branchId === undefined ? null : data.branchId,
      // The SHOP's day, worked out by the box against its own cutoff. Slicing on the calendar date
      // here would move a sale rung at half past midnight into the wrong day.
      tradingDay: data.tradingDay ?? '',
    },
    reportingPortsFromData(data),
  );
}

// In the browser `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as { window?: ManagerWindow }).window;
if (browserWindow !== undefined) {
  // The day close (M14-FR-04) reaches the store computer when the box injected its lane address;
  // without it the manager screen falls back to a local preview close that only touches this browser.
  browserWindow.managerSession = bootManager({
    data: browserWindow.managerData,
    laneWriteBase: browserWindow.laneWriteBase,
  });
  // The buyer's shell shares this bundle: one build, two screens, and each boots only what it was
  // given. A shell that was told nothing gets `undefined` and says so rather than showing zeros.
  const buying = bootBuying(browserWindow.buyingData, openProposePurchaseOrderPort());
  if (buying !== null) {
    browserWindow.buyingSession = buying;
    browserWindow.buyingGaps = buyingGaps(browserWindow.buyingData);
  }
  // The product publish this screen commits queues in a DEVICE-backed outbox, so a Save made while the link is
  // down survives the operator closing and reopening the tab before it syncs (P-01, §31).
  const catalogueOutbox = browserWindow.catalogueOutbox ?? openCatalogueOutbox();
  // The product publish rides the offline outbox; the promotion LAUNCH (M05-FR-03/04) and the price CHANGE
  // (M05-FR-02) are online governed actions that POST to head office on an explicit click — the cloud re-runs
  // the guard (re-simulate / re-check the MRP+cost+floor) and re-checks §28 for itself.
  const catalogue = bootCatalogue(browserWindow.catalogueData, catalogueOutbox, openPromotionLaunchPort(), openPriceChangePort());
  if (catalogue !== null) {
    browserWindow.catalogueSession = catalogue;
    browserWindow.catalogueGaps = catalogueGaps(browserWindow.catalogueData);
    browserWindow.catalogueOutbox = catalogueOutbox;
  }
  const merchandising = bootMerchandising(browserWindow.merchandisingData);
  if (merchandising !== null) {
    browserWindow.merchandisingSession = merchandising;
    browserWindow.merchandisingGaps = merchandisingGaps(browserWindow.merchandisingData);
  }
  const reporting = bootReporting(browserWindow.reportingData);
  if (reporting !== null) browserWindow.reportingSession = reporting;
  const service = bootService(browserWindow.serviceData);
  if (service !== null) browserWindow.serviceSession = service;
  const expiry = bootExpiry(browserWindow.expiryData);
  if (expiry !== null) browserWindow.expirySession = expiry;
  const finance = bootFinance(browserWindow.financeData);
  if (finance !== null) browserWindow.financeSession = finance;
  // The portal actions this screen commits queue in a DEVICE-backed outbox, so a poll/verify requested while
  // the link is down survives the operator closing and reopening the tab before it syncs (P-01, §31). A device
  // with no usable storage degrades to in-memory rather than failing — and says so, never silently.
  const gstReconciliationOutbox = browserWindow.gstReconciliationOutbox ?? openGstReconciliationOutbox();
  const gstReconciliation = bootGstReconciliation(browserWindow.gstReconciliationData, gstReconciliationOutbox);
  if (gstReconciliation !== null) {
    browserWindow.gstReconciliationSession = gstReconciliation;
    browserWindow.gstReconciliationOutbox = gstReconciliationOutbox;
  }
  const categoryPolicy = bootCategoryPolicy(browserWindow.categoryPolicyData);
  if (categoryPolicy !== null) browserWindow.categoryPolicySession = categoryPolicy;
  // The governance actions this screen commits queue in a DEVICE-backed outbox, so an approve/submit requested
  // while the link is down survives the operator closing and reopening the tab before it syncs (P-01, §31).
  const gstReturnsOutbox = browserWindow.gstReturnsOutbox ?? openGstReturnsOutbox();
  const gstReturns = bootGstReturns(browserWindow.gstReturnsData, gstReturnsOutbox);
  if (gstReturns !== null) {
    browserWindow.gstReturnsSession = gstReturns;
    browserWindow.gstReturnsOutbox = gstReturnsOutbox;
  }
  const waste = bootWaste(browserWindow.wasteData);
  if (waste !== null) browserWindow.wasteSession = waste;
  // The shop-floor write-off CAPTURE screen (M28-FR-01 · §28): boots from the box's policy (who + what they
  // hold + the material-loss threshold). The one write is a HUMAN record in the raiser's own name — never on
  // load, only on an explicit click — posted to the governed write-off route under the operator's own session;
  // the server sources the threshold, enforces evidence + a separate §28 approver, and records the loss in the
  // caller's own name, none of which the screen fabricates. No AI records a loss (hard rule #5).
  const writeOffCaptureData = browserWindow.writeOffCaptureData;
  const writeOffCapturePort = openWriteOffCapturePort();
  const writeOffCapture = bootWriteOffCapture(writeOffCaptureData, writeOffCapturePort);
  if (writeOffCapture !== null) {
    browserWindow.writeOffCaptureSession = writeOffCapture;
    browserWindow.writeOffCapture = { capturePort: () => writeOffCapturePort };
  }
  const counts = bootCounts(browserWindow.countsData);
  if (counts !== null) browserWindow.countsSession = counts;
  // The Data Quality inbox (A08): boots from the box's policy (who + what they hold), then the shell refreshes
  // the worklist with a live GET (read-only). Offline it shows its sample stand-in and says so. Read-only —
  // nothing here changes a product; the dismiss action is the follow-up increment.
  const dataQualityData = browserWindow.dataQualityInboxData;
  const dataQualityDismissPort = openDataQualityDismissPort();
  const dataQualityInbox = bootDataQualityInbox(dataQualityData, undefined, dataQualityDismissPort);
  if (dataQualityInbox !== null) {
    browserWindow.dataQualityInboxSession = dataQualityInbox;
    browserWindow.dataQualityInbox = {
      refresh: fetchDataQualityWorklist,
      present: (worklist) => createDataQualityInboxSession(
        { userId: dataQualityData?.userId === undefined ? null : dataQualityData.userId },
        dataQualityInboxPortsFromData(dataQualityData, worklist, dataQualityDismissPort),
      ),
    };
  }
  // The Operations inbox (A06): boots from the box's policy (who + what they hold), then the shell refreshes
  // the worklist with a live GET (read-only). Offline it shows its sample stand-in and says so. A06 recommends;
  // an operator acts (acknowledge the alert, then run the runbook), and setting a recommendation aside is a
  // HUMAN write in the operator's own name — the AI never writes it.
  const operationsData = browserWindow.operationsInboxData;
  const operationsDismissPort = openOperationsDismissPort();
  const operationsInbox = bootOperationsInbox(operationsData, undefined, operationsDismissPort);
  if (operationsInbox !== null) {
    browserWindow.operationsInboxSession = operationsInbox;
    browserWindow.operationsInbox = {
      refresh: fetchOperationsWorklist,
      present: (worklist) => createOperationsInboxSession(
        { userId: operationsData?.userId === undefined ? null : operationsData.userId },
        operationsInboxPortsFromData(operationsData, worklist, operationsDismissPort),
      ),
    };
  }
  // The loss-prevention investigations inbox (M15): boots from the box's policy (who + what they hold), then the
  // shell refreshes the open cases with a live GET (read-only). Offline it shows its sample stand-in and says so.
  // The one write is a HUMAN close in the manager's own name — never on load, only on an explicit click — and the
  // server enforces §28/evidence for a "proven" outcome, which the screen never fakes.
  const lossPreventionData = browserWindow.lossPreventionInboxData;
  const lpClosePort = openLpClosePort();
  const lossPreventionInbox = bootLpInbox(lossPreventionData, undefined, lpClosePort);
  if (lossPreventionInbox !== null) {
    browserWindow.lossPreventionInboxSession = lossPreventionInbox;
    browserWindow.lossPreventionInbox = {
      refresh: fetchLpWorklist,
      present: (worklist) => createLpInboxSession(
        { userId: lossPreventionData?.userId === undefined ? null : lossPreventionData.userId },
        lpInboxPortsFromData(lossPreventionData, worklist, lpClosePort),
      ),
    };
  }
  // The manager rostering screen (M25-FR-01): boots from the box's policy (who + what they hold), then the shell
  // refreshes the roster gaps with live GETs (read-only). Offline it shows its sample stand-in and says so. The
  // one write is a HUMAN assignment in the manager's own name — never on load, only on an explicit click — and
  // the server re-checks `workforce.roster.manage` and records it in the caller's name (no AI writes a roster,
  // hard rule #5).
  const rosteringData = browserWindow.rosteringData;
  const assignPort = openAssignPort();
  const rostering = bootRostering(rosteringData, undefined, assignPort);
  if (rostering !== null) {
    browserWindow.rosteringSession = rostering;
    browserWindow.rostering = {
      refresh: fetchRosteringWorklist,
      present: (worklist) => createRosteringSession(
        { userId: rosteringData?.userId === undefined ? null : rosteringData.userId },
        rosteringPortsFromData(rosteringData, worklist, assignPort),
      ),
    };
  }
  // The manager checklist screen (M25-FR-02): boots from the box's policy (who + what they hold), then the shell
  // refreshes the day's checklists with a live GET (read-only). Offline it shows its sample stand-in and says so.
  // The one write is a HUMAN sign-off in the manager's own name — never on load, only on an explicit click — and
  // the server re-checks `workforce.roster.manage` and refuses a blocking item still outstanding, which the
  // screen never fakes (hard rule #5: no AI signs a checklist).
  const checklistData = browserWindow.checklistData;
  const submitChecklistPort = openSubmitChecklistPort();
  const checklist = bootChecklist(checklistData, undefined, submitChecklistPort);
  if (checklist !== null) {
    browserWindow.checklistSession = checklist;
    browserWindow.checklist = {
      refresh: fetchChecklistWorklist,
      present: (worklist) => createChecklistSession(
        { userId: checklistData?.userId === undefined ? null : checklistData.userId },
        checklistPortsFromData(checklistData, worklist, submitChecklistPort),
      ),
    };
  }
  // The production quality-release screen (M11-FR-03): boots from the box's policy (who + what they hold), then
  // the shell refreshes the board with a live GET (read-only). Offline it shows its sample stand-in and says so.
  // The one write is a HUMAN release (or hold) in the operator's own name — never on load, only on an explicit
  // click — and the server re-checks `production.release` and refuses an expired batch, which the screen never
  // fakes (hard rule #5: no AI releases food for sale).
  const productionData = browserWindow.productionData;
  const releasePort = openReleasePort();
  const production = bootProduction(productionData, undefined, releasePort);
  if (production !== null) {
    browserWindow.productionSession = production;
    browserWindow.production = {
      refresh: fetchProductionBoard,
      present: (worklist) => createProductionSession(
        { userId: productionData?.userId === undefined ? null : productionData.userId },
        productionPortsFromData(productionData, worklist, releasePort),
      ),
    };
  }
  // The facilities maintenance & compliance screen (M26-FR-03): boots from the box's policy (who + what they
  // hold), then the shell refreshes the overdue list with a live GET (read-only). Offline it shows its sample
  // stand-in and says so. The one write is a HUMAN "mark done" in the manager's own name — never on load, only on
  // an explicit click — and the server re-checks `facilities.task.record` and refuses a completion with no
  // required evidence or a self-verified safety check (§28), which the screen never fakes (P-08).
  const facilitiesData = browserWindow.facilitiesData;
  const completePort = openCompletePort();
  const facilities = bootFacilities(facilitiesData, undefined, completePort);
  if (facilities !== null) {
    browserWindow.facilitiesSession = facilities;
    browserWindow.facilities = {
      refresh: fetchFacilitiesBoard,
      present: (worklist) => createFacilitiesSession(
        { userId: facilitiesData?.userId === undefined ? null : facilitiesData.userId },
        facilitiesPortsFromData(facilitiesData, worklist, completePort),
      ),
    };
  }
  // The refund-exceptions review screen (M13-FR-01/03 · M17): boots from the box's policy (who + what they hold),
  // then the shell refreshes the flagged refunds with a live GET (read-only). Offline it shows its sample stand-in
  // and says so. READ-ONLY — a breach is worked out of band (the money already moved at the lane), so there is no
  // write from this screen; the cloud route re-checks `lp.case.read`, so this only shapes the UI (P-03/P-08).
  const returnGovernanceData = browserWindow.returnGovernanceData;
  const returnGovernance = bootReturnGovernance(returnGovernanceData);
  if (returnGovernance !== null) {
    browserWindow.returnGovernanceSession = returnGovernance;
    browserWindow.returnGovernance = {
      refresh: fetchReturnGovernanceExceptions,
      present: (exceptions) => createReturnGovernanceSession(
        { userId: returnGovernanceData?.userId === undefined ? null : returnGovernanceData.userId },
        returnGovernancePortsFromData(returnGovernanceData, exceptions),
      ),
    };
  }
  // The cash-office over/short sign-off (M14-FR-02): boots from the box's policy (who + what they hold), then the
  // shell refreshes the open over/shorts with a live GET (read-only), keeping only the unsigned rows. Offline it
  // shows its sample stand-in and says so. The one write is a HUMAN sign-off in the reviewer's own name — never on
  // load, only on an explicit click — and the server enforces §28 (reviewer ≠ cashier), which the screen never fakes.
  const cashOfficeData = browserWindow.cashOfficeData;
  const signOffPort = openSignOffPort();
  const cashOffice = bootCashOffice(cashOfficeData, undefined, signOffPort);
  if (cashOffice !== null) {
    browserWindow.cashOfficeSession = cashOffice;
    browserWindow.cashOffice = {
      refresh: fetchOverShortWorklist,
      present: (worklist) => createCashOfficeSession(
        { userId: cashOfficeData?.userId === undefined ? null : cashOfficeData.userId },
        cashOfficePortsFromData(cashOfficeData, worklist, signOffPort),
      ),
    };
  }
  // The risk-acceptance / compliance-gates desk (M34-FR-04): boots from the box's policy (who + what they hold),
  // then the shell refreshes the blocked gates with a live GET (read-only). Offline it shows its sample stand-in
  // and says so. The one write is a HUMAN acceptance in the accepter's own name — never on load, only on an
  // explicit click — and the server records the name + rationale (§28), which the screen never fabricates.
  const riskAcceptanceData = browserWindow.riskAcceptanceData;
  const riskAcceptPort = openRiskAcceptPort();
  const riskAcceptance = bootRiskAcceptance(riskAcceptanceData, undefined, riskAcceptPort);
  if (riskAcceptance !== null) {
    browserWindow.riskAcceptanceSession = riskAcceptance;
    browserWindow.riskAcceptance = {
      refresh: fetchBlockedGates,
      present: (worklist) => createRiskAcceptanceSession(
        { userId: riskAcceptanceData?.userId === undefined ? null : riskAcceptanceData.userId },
        riskAcceptancePortsFromData(riskAcceptanceData, worklist, riskAcceptPort),
      ),
    };
  }
  // The day-reopen desk (M14-FR-04 / §28): boots from the box's policy (who + what they hold), then the shell
  // refreshes the LOCKED days with a live GET from the cloud (read-only). The one write — REOPEN a locked day
  // with a reason and a NAMED approver — runs only on an explicit click, and it posts to the BOX (cross-port),
  // not the cloud, because only the box can perform the reopen (it holds the locked day and re-queues it). The
  // screen refuses a self-approval before any POST (§28); the box enforces it and the cloud re-verifies authority.
  const dayReopenData = browserWindow.dayReopenData;
  const reopenPort = openDayReopenPort(browserWindow.laneWriteBase, dayReopenData?.userId === undefined ? null : dayReopenData.userId);
  const dayReopen = bootDayReopen(dayReopenData, undefined, reopenPort);
  if (dayReopen !== null) {
    browserWindow.dayReopenSession = dayReopen;
    browserWindow.dayReopen = {
      refresh: fetchLockedDays,
      present: (worklist) => createDayReopenSession(
        { userId: dayReopenData?.userId === undefined ? null : dayReopenData.userId },
        dayReopenPortsFromData(dayReopenData, worklist, reopenPort),
      ),
    };
  }
  // The stock-health dashboard (M08 — read-only): boots from the box's policy (who + whether they hold
  // inventory.availability.read + an optional snapshot), then the shell refreshes the five inventory figures
  // with live GETs (read-only). It changes nothing — the stock movements happen on other screens.
  const stockHealthData = browserWindow.stockHealthData;
  const stockHealth = bootStockHealth(stockHealthData, undefined);
  if (stockHealth !== null) {
    browserWindow.stockHealthSession = stockHealth;
    browserWindow.stockHealth = {
      refresh: fetchStockHealth,
      present: (snapshot) => createStockHealthSession(
        { userId: stockHealthData?.userId === undefined ? null : stockHealthData.userId },
        stockHealthPortsFromData(stockHealthData, snapshot),
      ),
    };
  }
  // The stored-value oversight desk (M17 — read-only): boots from the box's policy (who + whether they hold
  // lp.case.read), then the shell reads the three loss/books feeds with live GETs. It changes nothing — stored
  // value moves on other screens (a gift-card sale, a refund to credit); this only surfaces the exposure.
  const storedValueData = browserWindow.storedValueData;
  let storedValueCurrent: StoredValueOversightData = { liability: null, doubleSpends: [], velocity: [], asAt: '' };
  const storedValue = bootStoredValue(storedValueData, storedValueCurrent);
  if (storedValue !== null) {
    browserWindow.storedValueSession = storedValue;
    const presentStoredValue = (data: StoredValueOversightData): StoredValueOversightSession =>
      createStoredValueOversightSession(
        { userId: storedValueData?.userId === undefined ? null : storedValueData.userId },
        storedValuePortsFromData(storedValueData, data),
      );
    browserWindow.storedValue = {
      refresh: async () => {
        const velocity = await fetchStoredValueVelocity();
        if (velocity === null) return null;
        storedValueCurrent = { ...storedValueCurrent, velocity };
        return storedValueCurrent;
      },
      reconcile: async (postedMinor) => {
        const liability = await fetchStoredValueLiability(postedMinor);
        if (liability === null) return null;
        storedValueCurrent = { ...storedValueCurrent, liability };
        return storedValueCurrent;
      },
      lookup: async (ownerRef) => {
        const doubleSpends = await fetchStoredValueDoubleSpends(ownerRef);
        if (doubleSpends === null) return null;
        storedValueCurrent = { ...storedValueCurrent, doubleSpends };
        return storedValueCurrent;
      },
      present: presentStoredValue,
    };
  }
  // The integration-health desk (M32 — read-only): boots from the box's policy (who + whether they hold
  // platform.health.read), then the shell refreshes the adapter health picture with a live GET. It changes
  // nothing — it only surfaces which outside connections have gone quiet, and reassures the till never stops.
  const integrationHealthData = browserWindow.integrationHealthData;
  let integrationHealthCurrent: IntegrationHealthData = { adapters: [], posUnaffected: true, asAt: '' };
  const integrationHealth = bootIntegrationHealth(integrationHealthData, integrationHealthCurrent);
  if (integrationHealth !== null) {
    browserWindow.integrationHealthSession = integrationHealth;
    const presentIntegrationHealth = (data: IntegrationHealthData): IntegrationHealthSession =>
      createIntegrationHealthSession(
        { userId: integrationHealthData?.userId === undefined ? null : integrationHealthData.userId },
        integrationHealthPortsFromData(integrationHealthData, data),
      );
    browserWindow.integrationHealth = {
      refresh: async () => {
        const fresh = await fetchIntegrationHealth();
        if (fresh === null) return null;
        integrationHealthCurrent = fresh;
        return integrationHealthCurrent;
      },
      present: presentIntegrationHealth,
    };
  }
  // The goods-receipt review screen (M07 — read-only): boots from the box's policy (who + whether they hold
  // inventory.availability.read), then the shell refreshes the GRN list with a live GET. It changes nothing —
  // receiving is captured on the handheld, on the offline dock (§31); this only reviews the outcome.
  const goodsReceiptData = browserWindow.goodsReceiptData;
  const goodsReceipt = bootGoodsReceipt(goodsReceiptData, undefined);
  if (goodsReceipt !== null) {
    browserWindow.goodsReceiptSession = goodsReceipt;
    browserWindow.goodsReceipt = {
      refresh: fetchGoodsReceipt,
      present: (snapshot) => createGoodsReceiptSession(
        { userId: goodsReceiptData?.userId === undefined ? null : goodsReceiptData.userId },
        goodsReceiptPortsFromData(goodsReceiptData, snapshot),
      ),
    };
  }
  // The data import/export console (M30): boots from the box's policy (who + what they hold + the store's import
  // templates), then the shell refreshes the export catalogue + log with live GETs (read-only). The writes —
  // run an export (audited), validate a file (a preview), commit an import (§28: a SEPARATE approver, never the
  // uploader) — run only on an explicit click; the server re-validates and is the single gate.
  const dataIoData = browserWindow.dataIoData;
  const dataIo = bootDataIo(dataIoData, undefined);
  if (dataIo !== null) {
    browserWindow.dataIoSession = dataIo;
    browserWindow.dataIo = {
      refresh: fetchDataIoLive,
      present: (live) => createDataIoSession(
        { userId: dataIoData?.userId === undefined ? null : dataIoData.userId },
        dataIoPortsFromData(dataIoData, live),
      ),
    };
  }
  // The Workforce guidance inbox (A10): boots from the box's policy (who + what they hold), then the shell
  // refreshes the worklist with a live GET (read-only). Offline it shows its sample stand-in and says so. A10
  // flags; a manager acts (assign or complete the task the ordinary way), and setting guidance aside is a HUMAN
  // write in the manager's own name — the AI never writes it.
  const workforceData = browserWindow.workforceInboxData;
  const workforceDismissPort = openWorkforceDismissPort();
  const workforceInbox = bootWorkforceInbox(workforceData, undefined, workforceDismissPort);
  if (workforceInbox !== null) {
    browserWindow.workforceInboxSession = workforceInbox;
    browserWindow.workforceInbox = {
      refresh: fetchWorkforceWorklist,
      present: (worklist) => createWorkforceInboxSession(
        { userId: workforceData?.userId === undefined ? null : workforceData.userId },
        workforceInboxPortsFromData(workforceData, worklist, workforceDismissPort),
      ),
    };
  }
  // Employee self-service (M25): the member of staff's OWN rota + OWN payslip, one screen. Boots from the box's
  // policy (who is looking + whether they hold `payroll.ess.self`), then the shell refreshes both from live,
  // self-scoped GETs (/v1/hr/workforce/my-roster, /v1/hr/payroll/my-payslip). Offline it shows its sample and
  // says so. Read-only — the engine refuses any employee id but the caller's own, so nobody else's rota or pay
  // can ever be reached from here (P-04 least privilege, P-05 own-record only).
  const essData = browserWindow.essData;
  const ess = bootEss(essData);
  if (ess !== null) {
    browserWindow.essSession = ess;
    browserWindow.essLive = {
      refresh: async () => ({ roster: await fetchMyRoster(), payslip: await fetchMyPayslip() }),
      present: (live) => createEssSession(
        { userId: essData?.userId === undefined ? null : essData.userId },
        essPortsFromData(essData, live.roster, live.payslip),
      ),
    };
  }
  // The device fleet manager (M33-FR-02/04): boots only when the box carried who is looking. The fleet
  // itself is fetched from the cloud fleet-health call (wired next); until then the shell shows a sample.
  // Its register/block/retire actions commit to a device-backed outbox that survives a reload (§31); the
  // authenticated sync-drain delivery of those commands to the registry is the follow-up increment.
  const fleetOutbox = browserWindow.fleetOutbox ?? openFleetOutbox();
  const fleet = bootFleet(browserWindow.fleetData, fleetOutbox, openFleetDeliveryPort());
  if (fleet !== null) {
    browserWindow.fleetSession = fleet;
    browserWindow.fleetOutbox = fleetOutbox;
  }
  // The products-to-publish review shares the SAME device-backed catalogue outbox the Save button commits to,
  // so exactly what was queued there is what is reviewed here. Its delivery port POSTs a ready publish under
  // the operator's own session (ADR-0013). Nothing publishes on boot — only the explicit deliver action does.
  const productPublishReview = bootProductPublishReview(
    browserWindow.productPublishReviewData,
    catalogueOutbox as SyncOutbox<string, ProductPublishPayload>,
    openPublishDeliveryPort(),
  );
  if (productPublishReview !== null) {
    browserWindow.productPublishReviewSession = productPublishReview;
    browserWindow.productPublishReviewOutbox = catalogueOutbox;
  }
  // Payroll always boots a session (real from a payload, or a flagged DEMO one) — never blank.
  browserWindow.payrollSession = bootPayroll(browserWindow.payrollData);
  browserWindow.payrollEssSession = bootPayrollEss(browserWindow.payrollEssData);
  browserWindow.payrollReauth = markPayrollReauthenticated;
  const admin = bootAdmin(browserWindow.adminData);
  if (admin !== null) browserWindow.adminSession = admin;
  const setup = bootSetup(browserWindow.setupData);
  if (setup !== null && browserWindow.setupData !== undefined) {
    browserWindow.setupSession = setup;
    browserWindow.setupEditing = makeSetupEditing(browserWindow.setupData);
  }
  const ai = bootAi(browserWindow.aiData);
  if (ai !== null) browserWindow.aiSession = ai;
  const migration = bootMigration(browserWindow.migrationData);
  if (migration !== null) browserWindow.migrationSession = migration;
  const warehouseSupervisor = bootWarehouseSupervisor(browserWindow.warehouseSupervisorData);
  if (warehouseSupervisor !== null) {
    browserWindow.warehouseSupervisorSession = warehouseSupervisor;
    // The decisions the supervisor takes queue here for the sync agent to drain — the same in-memory
    // outbox the manager screen uses, so a decision made on this screen reaches the cloud the same way.
    browserWindow.warehouseSupervisorOutbox = new SyncOutbox();
  }
  // The view offers these and records the code the manager picks. It never composes a reason of
  // its own, so the audit trail keeps one vocabulary that can still be reported on in a year.
  browserWindow.managerReasons = { approved: APPROVE_REASONS, rejected: REJECT_REASONS };
}
