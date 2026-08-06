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

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface ManagerWindow {
  managerSession?: ManagerSession;
  managerData?: ManagerData;
  buyingSession?: BuyingSession;
  buyingData?: BuyingData;
  /** What the box did not tell the buyer's screen, so the screen can say it rather than guess. */
  buyingGaps?: readonly BuyingGap[];
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
  // The view offers these and records the code the manager picks. It never composes a reason of
  // its own, so the audit trail keeps one vocabulary that can still be reported on in a year.
  browserWindow.managerReasons = { approved: APPROVE_REASONS, rejected: REJECT_REASONS };
}
