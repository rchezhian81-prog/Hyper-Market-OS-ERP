// OPEN-TO-BUY — the category budget panel on the Buying page (WF-03 "demand/min-max/BUDGET → … → approval → PO" ·
// D02-FR-01 · D03-FR-01 · M06-FR-01 "PO above limit escalates" · OB-63 "Owner only" · P-03 · P-08). Round 12.
//
// The budget routes were built in round 8 (`services/purchase/src/open-to-buy.ts`) and had no screen. This is the panel's
// tested, DOM-free model; `web/buying.js` only draws what it hands over. It holds NO budget rule: what is committed, what
// is left, whether an order is over and who may issue it are head office's figures and head office's judgement, read from
//
//   • GET  /v1/purchase/open-to-buy?period=YYYY-MM[&storeId=]  — per category: budget, committed (issued orders raised that
//     month, net of cancellations), waiting (proposed, shown apart, never folded in), open-to-buy, and the month's
//     over-budget issues (who let each through, why, by how much);
//   • GET  /v1/purchase/budgets  — every figure ever set (a new one supersedes; the old stays on record);
//   • GET  /v1/purchase/orders   — each proposed order carries the open-to-buy check head office ran when it was raised;
//   • POST /v1/purchase/budgets  — the owner sets (or supersedes) a category's budget for a month, with a reason
//     (`purchase.budget.set`);
//   • POST /v1/purchase/orders/:poId/approval — a person who holds `purchase.order.approve` issues a waiting order; an
//     order over budget ESCALATES: head office refuses anyone who may not exceed the budget (OB-63: the owner only) and
//     asks the owner for an over-budget reason. The page shows those refusals in head office's own words.

import { bodyKey, type Answer, type HeadOfficeCall } from './supplier-bills-session';

export type BudgetState = 'within' | 'over' | 'no_budget';

export interface OpenToBuyRow {
  readonly categoryId: string;
  readonly budgetMinor: number | null;
  readonly budgetScope: 'store' | 'company' | null;
  readonly committedMinor: number;
  readonly waitingMinor: number;
  readonly openToBuyMinor: number | null;
  readonly openAfterWaitingMinor: number | null;
  readonly state: BudgetState;
}

export interface BudgetOverrideView { readonly poId: string; readonly approvedBy: string; readonly reason: string; readonly overByMinor: number; readonly at: string }

export interface OpenToBuyView {
  readonly period: string;
  readonly storeId: string | null;
  /** Over first, then within, then categories with no budget (control by exception, P-03). */
  readonly rows: readonly OpenToBuyRow[];
  readonly overrides: readonly BudgetOverrideView[];
  readonly asAt: string;
}

export interface BudgetVersion {
  readonly categoryId: string; readonly period: string; readonly storeId: string | null; readonly amountMinor: number;
  readonly reason: string; readonly setBy: string; readonly setAt: string;
  /** True when a later figure for the same category, month and store replaced it (kept on record, not in force). */
  readonly superseded: boolean;
}

/** A waiting order whose open-to-buy check says it is over budget — it escalates to the owner (OB-63). */
export interface Escalation {
  readonly poId: string;
  readonly supplierId: string;
  readonly requisitionedBy: string;
  readonly totalMinor: number;
  readonly overByMinor: number;
  readonly overCategories: readonly { readonly categoryId: string; readonly budgetMinor: number | null; readonly committedMinor: number; readonly thisOrderMinor: number }[];
}

export interface WaitingOrder {
  readonly poId: string;
  readonly supplierId: string;
  readonly requisitionedBy: string;
  readonly totalMinor: number;
  readonly deliverTo: string;
  /** The open-to-buy check head office put on the order when it was raised; null on an order raised before budgets. */
  readonly escalation: Escalation | null;
  readonly checked: boolean;
}

const rankState = (s: BudgetState): number => (s === 'over' ? 0 : s === 'within' ? 1 : 2);

export function presentOpenToBuy(raw: unknown): OpenToBuyView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (typeof b['period'] !== 'string' || !Array.isArray(b['categories'])) return null;
  const rows = (b['categories'] as OpenToBuyRow[]).map((r) => ({ ...r }));
  rows.sort((x, y) => rankState(x.state) - rankState(y.state) || (x.categoryId < y.categoryId ? -1 : 1));
  const overrides = (Array.isArray(b['overrides']) ? b['overrides'] as Record<string, unknown>[] : []).map((o) => ({
    poId: String(o['poId']), approvedBy: String(o['approvedBy']), reason: String(o['reason']), overByMinor: Number(o['overByMinor'] ?? 0), at: String(o['at'] ?? ''),
  }));
  return { period: b['period'], storeId: typeof b['storeId'] === 'string' ? b['storeId'] : null, rows, overrides, asAt: String(b['asAt'] ?? '') };
}

/** Every figure set for a month, newest first, each marked superseded when a later one for the same key replaced it. */
export function budgetHistory(raw: unknown, period: string): readonly BudgetVersion[] {
  const all = Array.isArray((raw as { budgets?: unknown } | null)?.budgets) ? (raw as { budgets: BudgetVersion[] }).budgets : [];
  const key = (v: { categoryId: string; period: string; storeId: string | null }): string => `${v.categoryId}|${v.period}|${v.storeId ?? '*'}`;
  const lastIndex = new Map<string, number>();
  all.forEach((v, i) => lastIndex.set(key(v), i));
  return all
    .map((v, i) => ({ categoryId: v.categoryId, period: v.period, storeId: v.storeId ?? null, amountMinor: v.amountMinor, reason: v.reason, setBy: v.setBy, setAt: v.setAt, superseded: lastIndex.get(key(v)) !== i }))
    .filter((v) => v.period === period)
    .reverse();
}

/** The orders raised in `period` still waiting for a second person, each with its escalation when head office found it over. */
export function waitingOrders(raw: unknown, period: string): readonly WaitingOrder[] {
  const orders = Array.isArray((raw as { orders?: unknown } | null)?.orders) ? (raw as { orders: Record<string, unknown>[] }).orders : [];
  return orders
    .filter((o) => o['status'] === 'proposed' && typeof o['at'] === 'string' && (o['at'] as string).slice(0, 7) === period)
    .map((o) => {
      const check = o['budgetCheck'] as { overBudget?: boolean; overByMinor?: number; categories?: { categoryId: string; state: string; budgetMinor: number | null; committedMinor: number; thisOrderMinor: number }[] } | undefined;
      const escalation: Escalation | null = check?.overBudget === true ? {
        poId: String(o['poId']), supplierId: String(o['supplierId']), requisitionedBy: String(o['requisitionedBy']), totalMinor: Number(o['totalMinor'] ?? 0),
        overByMinor: Number(check.overByMinor ?? 0),
        overCategories: (check.categories ?? []).filter((c) => c.state === 'over').map((c) => ({ categoryId: c.categoryId, budgetMinor: c.budgetMinor, committedMinor: c.committedMinor, thisOrderMinor: c.thisOrderMinor })),
      } : null;
      return {
        poId: String(o['poId']), supplierId: String(o['supplierId']), requisitionedBy: String(o['requisitionedBy']), totalMinor: Number(o['totalMinor'] ?? 0),
        deliverTo: String(o['deliverTo'] ?? o['deliverToLocationId'] ?? ''), escalation, checked: check !== undefined,
      };
    })
    // Escalations first (P-03).
    .sort((a, b) => Number(b.escalation !== null) - Number(a.escalation !== null));
}

/** Rupees as typed → paise exactly (from the decimal text); undefined when not money. */
const paise = (text: string): number | undefined => {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.replace(/[,\s₹]/g, ''));
  return m === null ? undefined : Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
};

export type BudgetEntry =
  | { readonly ok: true; readonly body: { readonly categoryId: string; readonly period: string; readonly amountMinor: number; readonly reason: string; readonly storeId?: string } }
  | { readonly ok: false; readonly problem: 'fill_category_amount_reason' | 'not_money' };

/** The budget body as the owner typed it — only its shape; whether it is a budget head office keeps is head office's call. */
export function budgetEntry(input: { readonly categoryId: string; readonly period: string; readonly amount: string; readonly reason: string; readonly storeId?: string }): BudgetEntry {
  if (input.categoryId.trim() === '' || input.amount.trim() === '' || input.reason.trim() === '') return { ok: false, problem: 'fill_category_amount_reason' };
  const amountMinor = paise(input.amount);
  if (amountMinor === undefined) return { ok: false, problem: 'not_money' };
  return {
    ok: true,
    body: { categoryId: input.categoryId.trim(), period: input.period, amountMinor, reason: input.reason.trim(), ...(input.storeId !== undefined && input.storeId.trim() !== '' ? { storeId: input.storeId.trim() } : {}) },
  };
}

const answerOf = <T>(r: { status: number; body: unknown } | 'unreachable', take: (body: unknown) => T): Answer<T> => {
  if (r === 'unreachable') return { ok: false, unreachable: true };
  if (r.status >= 200 && r.status < 300) return { ok: true, value: take(r.body) };
  const e = ((r.body ?? {}) as { error?: { code?: string; whatHappened?: string; nextSafeAction?: string } }).error ?? {};
  return { ok: false, unreachable: false, status: r.status, code: e.code ?? String(r.status), whatHappened: e.whatHappened ?? `head office answered ${r.status}`, nextSafeAction: e.nextSafeAction ?? '' };
};

export interface OpenToBuySession {
  /** May read the panel (`purchase.commitment.read`). */
  readonly mayRead: boolean;
  /** May set a budget (`purchase.budget.set` — the owner's). */
  readonly maySetBudget: boolean;
  /** May issue a waiting order (`purchase.order.approve`). Whether an order OVER budget issues is head office's call (OB-63). */
  readonly mayIssue: boolean;
  read(period: string, storeId?: string): Promise<Answer<{ readonly view: OpenToBuyView; readonly history: readonly BudgetVersion[]; readonly waiting: readonly WaitingOrder[] }>>;
  setBudget(input: Parameters<typeof budgetEntry>[0]): Promise<Answer<{ readonly supersedes: boolean }> | Extract<BudgetEntry, { ok: false }>>;
  issue(poId: string, reason: string, overBudgetReason?: string): Promise<Answer<{ readonly overBudget: boolean }>>;
}

export function createOpenToBuySession(call: HeadOfficeCall, viewer: { readonly permissions: readonly string[] }): OpenToBuySession {
  const may = new Set(viewer.permissions);
  return {
    mayRead: may.has('purchase.commitment.read'),
    maySetBudget: may.has('purchase.budget.set'),
    mayIssue: may.has('purchase.order.approve'),
    read: async (period, storeId) => {
      const q = `period=${encodeURIComponent(period)}${storeId !== undefined && storeId.trim() !== '' ? `&storeId=${encodeURIComponent(storeId.trim())}` : ''}`;
      const otb = answerOf(await call({ method: 'GET', path: `/v1/purchase/open-to-buy?${q}` }), presentOpenToBuy);
      if (!otb.ok) return otb;
      if (otb.value === null) return { ok: false, unreachable: false, status: 200, code: 'unreadable', whatHappened: 'head office answered with something that is not open-to-buy', nextSafeAction: '' };
      const budgets = await call({ method: 'GET', path: '/v1/purchase/budgets' });
      const orders = await call({ method: 'GET', path: '/v1/purchase/orders' });
      const history = budgets !== 'unreachable' && budgets.status < 300 ? budgetHistory(budgets.body, period) : [];
      const waiting = orders !== 'unreachable' && orders.status < 300 ? waitingOrders(orders.body, period) : [];
      return { ok: true, value: { view: otb.value, history, waiting } };
    },
    setBudget: async (input) => {
      const entry = budgetEntry(input);
      if (!entry.ok) return entry;
      return answerOf(await call({ method: 'POST', path: '/v1/purchase/budgets', body: entry.body, idempotencyKey: bodyKey('budget', entry.body) }),
        (b) => ({ supersedes: (b as { supersedes?: unknown }).supersedes !== null && (b as { supersedes?: unknown }).supersedes !== undefined }));
    },
    issue: async (poId, reason, overBudgetReason) => {
      const body = { reason: reason.trim(), ...(overBudgetReason !== undefined && overBudgetReason.trim() !== '' ? { overBudgetReason: overBudgetReason.trim() } : {}) };
      return answerOf(await call({ method: 'POST', path: `/v1/purchase/orders/${encodeURIComponent(poId)}/approval`, body, idempotencyKey: bodyKey(`issue-${poId}`, body) }),
        (b) => ({ overBudget: ((b as { budgetAtApproval?: { overBudget?: boolean } }).budgetAtApproval?.overBudget) === true }));
    },
  };
}
