// API-03 Open-to-buy and category purchase budgets (WF-03 · D02-FR-01 · D03-FR-01 · M06-FR-01 · §28 · P-03 · P-08) — round 8.
//
// WF-03's path is "demand/min-max/BUDGET → requisition → RFQ → comparison → approval → PO". The budget step had no build.
// Now:
//
//   • a BUDGET is head office's spend limit for one category in one month (optionally for one store), set by a person who
//     holds `purchase.budget.set`; a new figure for the same category/month/store is a new record that supersedes the old
//     (append-only, the history kept, a reason required);
//   • OPEN-TO-BUY for a category/month is the budget less what is already COMMITTED — the issued orders raised in that
//     month, at their order value net of approved cancellations — and what is WAITING (proposed, not yet approved) is shown
//     beside it, never folded in silently;
//   • a purchase order is CHECKED when it is proposed (the check rides on the order, so the approver sees it) and again
//     when it is approved (other orders may have been issued since). Within budget, or no budget set for a category (said,
//     never read as "unlimited" silently): approval proceeds as before. OVER budget: the roadmap's rule for a purchase over
//     a limit is that it ESCALATES (M06-FR-01 "PO above limit escalates") — the order is not refused, but only an approver
//     who holds `purchase.budget.exceed` may issue it, and only with an over-budget reason; the override is recorded and
//     audited. Nobody else can issue it (409 `over_open_to_buy`), and the buyer can never approve their own order (§28).
//
// A product's category is the product master's department (`primaryCategoryId`); a product with none is "uncategorised"
// and judged against an "uncategorised" budget if one is set. The month is the month the order was raised.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { valueAtCost } from '../../../packages/contracts/src/quantity';
import type { StoredPurchaseOrder } from './purchase-orders';

export const UNCATEGORISED = 'uncategorised';

/** One budget figure: a category's purchase limit for a month (and a store, when set per store). Latest per key wins. */
export interface PurchaseBudget {
  readonly categoryId: string;
  /** YYYY-MM */
  readonly period: string;
  /** null = for the whole company; a store id = for that store's orders only. */
  readonly storeId: string | null;
  readonly amountMinor: number;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}
/**
 * WF-03 (round 10): the write guard over one month's open-to-buy. An approval reads its version BEFORE it reads the orders
 * the budget is judged on, and issues only while it still holds — so two approvals at the same moment can never both
 * spend the same remaining budget (the loser is a named 409 `concurrent_change`, nothing issued; asked again, it is judged
 * on what the winner committed).
 */
export const openToBuyGuardKey = (period: string): string => `open-to-buy:${period}`;
export const budgetKey = (b: Pick<PurchaseBudget, 'categoryId' | 'period' | 'storeId'>): string => `${b.categoryId}|${b.period}|${b.storeId ?? '*'}`;

/** How one category stands for one order. */
export interface CategoryCheck {
  readonly categoryId: string;
  readonly budgetMinor: number | null;
  readonly budgetScope: 'store' | 'company' | null;
  /** Issued orders raised in the month (net of cancellations), other than this one. */
  readonly committedMinor: number;
  /** Proposed orders raised in the month waiting for approval, other than this one — shown, not counted. */
  readonly waitingMinor: number;
  readonly thisOrderMinor: number;
  /** budget − committed − this order; null with no budget. */
  readonly remainingAfterMinor: number | null;
  readonly state: 'within' | 'over' | 'no_budget';
}
export interface BudgetCheck {
  readonly period: string;
  readonly storeId: string | null;
  readonly categories: readonly CategoryCheck[];
  readonly overBudget: boolean;
  /** How much the most-over category is over by (0 when none is). */
  readonly overByMinor: number;
  readonly checkedAt: string;
}

/** A recorded over-budget issue: who let it through, why, and by how much (the escalation's evidence). */
export interface BudgetOverride {
  readonly poId: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly overByMinor: number;
  readonly check: BudgetCheck;
  readonly at: string;
}

export interface OpenToBuyDeps {
  readonly budgets: (tenantId: string) => Promise<readonly PurchaseBudget[]> | readonly PurchaseBudget[];
  readonly recordBudget: (tenantId: string, budget: PurchaseBudget) => Promise<void> | void;
  readonly orders: (tenantId: string) => Promise<readonly StoredPurchaseOrder[]> | readonly StoredPurchaseOrder[];
  readonly categoryOf: (tenantId: string, productId: string) => Promise<string | null | undefined> | string | null | undefined;
  /** Which store a location belongs to (the order's deliver-to → its store), for a per-store budget. */
  readonly storeOf?: (tenantId: string) => Promise<(locationId: string) => string> | ((locationId: string) => string);
  readonly overrides: (tenantId: string) => Promise<readonly BudgetOverride[]> | readonly BudgetOverride[];
  readonly recordOverride: (tenantId: string, o: BudgetOverride) => Promise<void> | void;
  /** What the approver holds — the over-budget authority is read from their grants, never from the request. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** WF-03 (round 10): the version of a month's open-to-buy write guard (`openToBuyGuardKey`). Absent on a bare stub. */
  readonly budgetVersion?: (tenantId: string, period: string) => Promise<number> | number;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPeriod = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** The value of an order per category (net of cancellations, at its own cost). */
async function valueByCategory(deps: OpenToBuyDeps, tenantId: string, po: StoredPurchaseOrder): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const cancelledLeft = new Map(Object.entries(po.cancelledByProduct ?? {}));
  for (const l of po.lines) {
    const cancelled = Math.min(cancelledLeft.get(l.productId) ?? 0, l.orderedQty);
    cancelledLeft.set(l.productId, (cancelledLeft.get(l.productId) ?? 0) - cancelled);
    const qty = l.orderedQty - cancelled;
    const category = (await deps.categoryOf(tenantId, l.productId)) ?? UNCATEGORISED;
    out.set(category, (out.get(category) ?? 0) + valueAtCost(qty, l.uom ?? 'ea', l.unitCost));
  }
  return out;
}

/** The budget that governs a category for a store in a month: the store's own, else the company's, else none. */
const governing = (budgets: readonly PurchaseBudget[], categoryId: string, period: string, storeId: string | null): PurchaseBudget | undefined => {
  const latest = new Map<string, PurchaseBudget>();
  for (const b of budgets) latest.set(budgetKey(b), b);
  return (storeId === null ? undefined : latest.get(budgetKey({ categoryId, period, storeId }))) ?? latest.get(budgetKey({ categoryId, period, storeId: null }));
};

/**
 * Check one order against open-to-buy (pure on the deps' reads). Committed = issued orders raised in the same month, for the
 * same store when the budget is the store's, other than this one; waiting = proposed ones. Over when budget − committed −
 * this order < 0.
 */
export async function checkOrderAgainstBudget(deps: OpenToBuyDeps, tenantId: string, po: StoredPurchaseOrder): Promise<BudgetCheck> {
  const period = po.at.slice(0, 7);
  const storeOf = deps.storeOf === undefined ? (l: string) => l : await deps.storeOf(tenantId);
  const storeId = po.deliverToLocationId === undefined ? null : storeOf(po.deliverToLocationId);
  const [budgets, orders] = await Promise.all([deps.budgets(tenantId), deps.orders(tenantId)]);
  const mine = await valueByCategory(deps, tenantId, po);
  const others = orders.filter((o) => o.poId !== po.poId && o.at.slice(0, 7) === period);
  const otherValues = await Promise.all(others.map(async (o) => ({ o, v: await valueByCategory(deps, tenantId, o), store: o.deliverToLocationId === undefined ? null : storeOf(o.deliverToLocationId) })));
  const categories: CategoryCheck[] = [];
  for (const [categoryId, thisOrderMinor] of [...mine].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const budget = governing(budgets, categoryId, period, storeId);
    const sameScope = otherValues.filter((x) => budget === undefined || budget.storeId === null || x.store === budget.storeId);
    const committedMinor = sameScope.filter((x) => x.o.status === 'issued').reduce((s, x) => s + (x.v.get(categoryId) ?? 0), 0);
    const waitingMinor = sameScope.filter((x) => x.o.status === 'proposed').reduce((s, x) => s + (x.v.get(categoryId) ?? 0), 0);
    if (budget === undefined) {
      categories.push({ categoryId, budgetMinor: null, budgetScope: null, committedMinor, waitingMinor, thisOrderMinor, remainingAfterMinor: null, state: 'no_budget' });
      continue;
    }
    const remainingAfterMinor = budget.amountMinor - committedMinor - thisOrderMinor;
    categories.push({ categoryId, budgetMinor: budget.amountMinor, budgetScope: budget.storeId === null ? 'company' : 'store', committedMinor, waitingMinor, thisOrderMinor, remainingAfterMinor, state: remainingAfterMinor < 0 ? 'over' : 'within' });
  }
  const overByMinor = categories.reduce((m, c) => Math.max(m, c.remainingAfterMinor !== null && c.remainingAfterMinor < 0 ? -c.remainingAfterMinor : 0), 0);
  return { period, storeId, categories, overBudget: categories.some((c) => c.state === 'over'), overByMinor, checkedAt: deps.now() };
}

/**
 * The approval gate's judgement (the PO approval route calls it before it issues): within budget → proceed; over → only an
 * approver holding `purchase.budget.exceed`, with an over-budget reason. Throws by name otherwise. The override is NOT yet
 * recorded: `recordOverride` records it (and its audit line) — the route calls it only once the order has really issued, so
 * an approval that loses the open-to-buy race leaves no override behind.
 */
export async function judgeApprovalOnBudget(deps: OpenToBuyDeps, ctx: { readonly tenantId: string; readonly userId: string; readonly branchId?: string | null },
  po: StoredPurchaseOrder, overBudgetReason: unknown): Promise<{ readonly check: BudgetCheck; readonly recordOverride?: () => Promise<void> }> {
  const check = await checkOrderAgainstBudget(deps, ctx.tenantId, po);
  if (!check.overBudget) return { check };
  const over = check.categories.filter((c) => c.state === 'over').map((c) => `${c.categoryId} by ${-(c.remainingAfterMinor ?? 0)} (budget ${c.budgetMinor}, committed ${c.committedMinor}, this order ${c.thisOrderMinor})`).join('; ');
  if (!((await deps.permissionsOfUser(ctx.tenantId, ctx.userId)) ?? []).includes('purchase.budget.exceed')) {
    throw apiError(409, {
      code: 'over_open_to_buy',
      whatHappened: `Purchase order ${po.poId} would take ${check.period}'s purchase budget over: ${over}. An order over budget escalates — only a person allowed to exceed the budget can issue it.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Reduce the order, or ask the person who may approve over budget (the owner) to issue it with a reason. Nothing was issued.',
    });
  }
  if (!isStr(overBudgetReason)) {
    throw apiError(422, {
      code: 'over_budget_reason_required',
      whatHappened: `Purchase order ${po.poId} is over budget (${over}); issuing it needs an over-budget reason on the record.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send { reason, overBudgetReason } and approve again. Nothing was issued.',
    });
  }
  const reason = overBudgetReason.trim();
  const recordOverride = async (): Promise<void> => {
    const at = deps.now();
    await deps.recordOverride(ctx.tenantId, { poId: po.poId, approvedBy: ctx.userId, reason, overByMinor: check.overByMinor, check, at });
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action: 'purchase.budget.exceed', objectType: 'purchase-order', objectId: po.poId, at,
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { overBudget: 'true' },
      after: { overByMinor: String(check.overByMinor), period: check.period, categories: check.categories.filter((c) => c.state === 'over').map((c) => c.categoryId).join(',') },
      reason, correlationId: po.poId,
    });
  };
  return { check, recordOverride };
}

/** The gate as one step: judge, and record an override at once (for a caller that issues nothing under the budget guard). */
export async function gateApprovalOnBudget(deps: OpenToBuyDeps, ctx: { readonly tenantId: string; readonly userId: string; readonly branchId?: string | null },
  po: StoredPurchaseOrder, overBudgetReason: unknown): Promise<BudgetCheck> {
  const judged = await judgeApprovalOnBudget(deps, ctx, po, overBudgetReason);
  await judged.recordOverride?.();
  return judged.check;
}

export function openToBuyRoutes(deps: OpenToBuyDeps): readonly Route[] {
  return [
    {
      // Set (or supersede) a category's purchase budget for a month — head office's figure, with a reason.
      api: 'API-03', method: 'POST', path: '/v1/purchase/budgets',
      permission: 'purchase.budget.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['categoryId']) || !isPeriod(b['period']) || !Number.isSafeInteger(b['amountMinor']) || (b['amountMinor'] as number) < 0
          || !isStr(b['reason']) || (b['storeId'] !== undefined && b['storeId'] !== null && !isStr(b['storeId']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_purchase_budget',
            whatHappened: 'A purchase budget needs { categoryId, period (YYYY-MM), amountMinor (whole, not negative), reason } and optionally storeId (else it is for the whole company).',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the budget. Nothing was recorded.',
          });
        }
        const budget: PurchaseBudget = {
          categoryId: b['categoryId'].trim(), period: b['period'], storeId: isStr(b['storeId']) ? b['storeId'].trim() : null,
          amountMinor: b['amountMinor'] as number, reason: b['reason'].trim(), setBy: ctx.userId, setAt: deps.now(),
        };
        const before = governing(await deps.budgets(ctx.tenantId), budget.categoryId, budget.period, budget.storeId);
        await deps.recordBudget(ctx.tenantId, budget);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'purchase.budget.set', objectType: 'purchase-budget', objectId: budgetKey(budget), at: budget.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: before === undefined || budgetKey(before) !== budgetKey(budget) ? null : { amountMinor: String(before.amountMinor) },
          after: { amountMinor: String(budget.amountMinor) }, reason: budget.reason, correlationId: budgetKey(budget),
        });
        return { status: 201, body: { budget, supersedes: before !== undefined && budgetKey(before) === budgetKey(budget) ? before : null } };
      },
    },
    {
      // Open-to-buy for a month: per category, the budget, what is committed, what waits for approval, what is left.
      api: 'API-03', method: 'GET', path: '/v1/purchase/open-to-buy',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const period = ctx.query['period'];
        if (!isPeriod(period)) {
          throw apiError(400, { code: 'not_readable_as_an_open_to_buy_query', whatHappened: 'Open-to-buy is read for a month: ?period=YYYY-MM (and optionally &storeId=).', wasItSaved: 'not_saved', nextSafeAction: 'Send the month. Nothing was changed.' });
        }
        const storeId = isStr(ctx.query['storeId']) ? ctx.query['storeId'] : null;
        const storeOf = deps.storeOf === undefined ? (l: string) => l : await deps.storeOf(ctx.tenantId);
        const [budgets, orders, overrides] = await Promise.all([deps.budgets(ctx.tenantId), deps.orders(ctx.tenantId), deps.overrides(ctx.tenantId)]);
        const inMonth = orders.filter((o) => o.at.slice(0, 7) === period && (storeId === null || (o.deliverToLocationId !== undefined && storeOf(o.deliverToLocationId) === storeId)));
        const byCat = new Map<string, { committedMinor: number; waitingMinor: number }>();
        for (const o of inMonth) {
          for (const [c, v] of await valueByCategory(deps, ctx.tenantId, o)) {
            const acc = byCat.get(c) ?? { committedMinor: 0, waitingMinor: 0 };
            if (o.status === 'issued') acc.committedMinor += v; else acc.waitingMinor += v;
            byCat.set(c, acc);
          }
        }
        const latest = new Map<string, PurchaseBudget>();
        for (const b of budgets) if (b.period === period && (b.storeId === null || b.storeId === storeId)) latest.set(budgetKey(b), b);
        for (const b of latest.values()) if (!byCat.has(b.categoryId)) byCat.set(b.categoryId, { committedMinor: 0, waitingMinor: 0 });
        const rows = [...byCat].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([categoryId, acc]) => {
          const budget = governing([...latest.values()], categoryId, period, storeId);
          const openToBuyMinor = budget === undefined ? null : budget.amountMinor - acc.committedMinor;
          return {
            categoryId, budgetMinor: budget?.amountMinor ?? null, budgetScope: budget === undefined ? null : budget.storeId === null ? 'company' : 'store',
            ...acc, openToBuyMinor, openAfterWaitingMinor: openToBuyMinor === null ? null : openToBuyMinor - acc.waitingMinor,
            state: budget === undefined ? 'no_budget' : (openToBuyMinor as number) < 0 ? 'over' : 'within',
          };
        });
        const monthOverrides = overrides.filter((o) => o.check.period === period);
        return { status: 200, body: { period, storeId, categories: rows, overrides: monthOverrides, asAt: deps.now() } };
      },
    },
    {
      // Every budget figure ever set (the history: a superseded figure stays on the record).
      api: 'API-03', method: 'GET', path: '/v1/purchase/budgets',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => ({ status: 200, body: { budgets: await deps.budgets(ctx.tenantId), asAt: deps.now() } }),
    },
  ];
}
