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

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface ManagerWindow {
  managerSession?: ManagerSession;
  managerData?: ManagerData;
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

// In the browser `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as { window?: ManagerWindow }).window;
if (browserWindow !== undefined) {
  browserWindow.managerSession = bootManager({ data: browserWindow.managerData });
  // The view offers these and records the code the manager picks. It never composes a reason of
  // its own, so the audit trail keeps one vocabulary that can still be reported on in a year.
  browserWindow.managerReasons = { approved: APPROVE_REASONS, rejected: REJECT_REASONS };
}
