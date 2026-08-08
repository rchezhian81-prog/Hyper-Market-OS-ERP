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
import { makeTradingDayRule } from '../../../packages/calendar/src/trading-day';
import {
  APPROVE_REASONS,
  REJECT_REASONS,
  createManagerSession,
  disconnectedPorts,
  notKnown,
  type ApprovalRegister,
  type DecisionReasonCode,
  type ManagerPorts,
  type ManagerSession,
  type Register,
  type RegisterItem,
  type ValueRegister,
} from './manager-session';
import type { ApprovalRequest } from '../../../packages/approvals/src/approvals';
import { createBuyingSession, type BuyingPorts, type BuyingSession, type InvoiceLine } from './buying-session';
import {
  createCatalogueSession,
  type CataloguePorts, type CatalogueSession,
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
} from './expiry-session';
import type { Batch } from '../../../packages/fefo/src/index';
import {
  createFinanceSession, type FinancePorts, type FinanceSession,
} from './finance-session';
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
import type { UserAccount } from '../../../packages/identity/src/index';
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
): ExpiryPorts {
  return {
    batches: () => data?.batches ?? [],
    ledger: () => ledger,
    recalls: () => data?.recalls ?? [],
    // NOT defaulted to `{}`. An empty name map and no name map read the same to a lookup, and the
    // screen needs to fall back to the product code rather than showing a blank where a food
    // product's name belongs.
    productNames: () => data?.productNames,
  };
}

/** Build the expiry and recall screen, or `null` when the box was told no near-expiry window. */
export function bootExpiry(data: ExpiryData | undefined, ledger?: Ledger): ExpirySession | null {
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
    expiryPortsFromData(data, ledger ?? new Ledger(new InMemoryLedgerStore())),
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
  buyingSession?: BuyingSession;
  buyingData?: BuyingData;
  /** What the box did not tell the buyer's screen, so the screen can say it rather than guess. */
  buyingGaps?: readonly BuyingGap[];
  catalogueSession?: CatalogueSession;
  catalogueData?: CatalogueData;
  catalogueGaps?: readonly CatalogueGap[];
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
}): ManagerSession {
  // `??` would be wrong here and was: an explicit `null` means *company-wide*, and `null ?? 'store-1'`
  // quietly demoted a company-wide manager to one branch — where their own scope then blocked them
  // from deciding anything outside it. Only `undefined` means "not configured".
  const branchId = config?.branchId === undefined ? 'store-1' : config.branchId;
  const limit = config?.approvalLimitMinor;
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
    portsFromData(config?.data),
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
export function buyingPortsFromData(data: BuyingData | undefined): BuyingPorts {
  return {
    knownProductIds: () => data?.productIds ?? [],
    orderedLines: (poId) => data?.ordered?.[poId] ?? [],
    receivedLines: (poId) => data?.received?.[poId] ?? [],
    capturedLines: (invoiceId) => data?.captured?.[invoiceId] ?? [],
  };
}

/** Build the buyer's session, or `null` when this box was told nothing about buying. */
export function bootBuying(data: BuyingData | undefined): BuyingSession | null {
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
    buyingPortsFromData(data),
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
export function cataloguePortsFromData(data: CatalogueData | undefined): CataloguePorts {
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
  };
}

/** Build the product-and-pricing session, or `null` when this box was told nothing about it. */
export function bootCatalogue(data: CatalogueData | undefined): CatalogueSession | null {
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
    cataloguePortsFromData(data),
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
  browserWindow.managerSession = bootManager({ data: browserWindow.managerData });
  // The buyer's shell shares this bundle: one build, two screens, and each boots only what it was
  // given. A shell that was told nothing gets `undefined` and says so rather than showing zeros.
  const buying = bootBuying(browserWindow.buyingData);
  if (buying !== null) {
    browserWindow.buyingSession = buying;
    browserWindow.buyingGaps = buyingGaps(browserWindow.buyingData);
  }
  const catalogue = bootCatalogue(browserWindow.catalogueData);
  if (catalogue !== null) {
    browserWindow.catalogueSession = catalogue;
    browserWindow.catalogueGaps = catalogueGaps(browserWindow.catalogueData);
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
