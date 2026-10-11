// API-09 Finance — the period's books (WF-18 "post interfaces → reconcile stock/AP/AR → exceptions → period close → P&L" ·
// M23-FR-01/04 · D10-FR-01/03 · WF-08 "variance → approval → adjustment/accounting" · QG-07 · P-08 · hard rule #2).
//
// Three things the month close lacked:
//
//   1. COUNT DIFFERENCES AND WRITE-OFFS REACH THE BOOKS. A count whose correction was applied on the stock ledger (B2's
//      count reconciliation, valued at head office's own cost) and a write-off on the register (M28, including a held
//      returned unit written off) each become ONE balanced journal through the accountant's mapping —
//      `stock_count:shortage` / `stock_count:surplus` / `stock_write_off` — once per source: a re-run posts nothing twice.
//      A count whose cost head office does not hold is listed, not posted at zero (P-08). A closed month takes nothing:
//      the journal goes to the next open period carrying its real date.
//   2. THE CLOSE RECONCILES THE BOOKS TO THEIR REGISTERS. Beside the card/UPI and bank checks, the close now compares
//      (a) the month's count differences and write-offs on the stock registers against the journals the books hold for
//      them; (b) what the purchase register says the shop owes its suppliers against the payables control account;
//      (c) what the credit-customer ledger says customers owe against the receivables control account. Each pair is two
//      figures reached two different ways; a difference holds the close and names what is unposted.
//   3. A PERIOD PROFIT AND LOSS FROM THE BOOKS. Every journal posted to the month, summed per account, each account read
//      as income or expense by the accountant's account classes (a suggested set ships for the suggested mapping; the CA
//      commits their own). An account in the month with no class is listed and the statement says it is incomplete —
//      never silently left out. What the books do not yet carry is said, not invented (cost of goods sold: the stock
//      ledger values every sale, but no cost-of-sales journal is posted until the CA chooses how — see `notInTheBooks`).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { postJournal as postMapped, UnmappedKindError, MissingComponentError, UnbalancedJournalError } from '../../../packages/finance/src/posting';
import { postJournal, type FinanceDeps, type JournalEntry, type ControlTotalCheck } from './index';
import type { StoredPostingMap } from './day-book';

// ── 1. Count differences and write-offs to the books ─────────────────────────────────────────────────────────────

/** One stock adjustment the books must carry: an applied count difference, or a write-off on the register. */
export interface StockAdjustmentSource {
  /** `count:<countId>` or `write_off:<writeOffId>` — one journal per source. */
  readonly sourceId: string;
  readonly kind: 'stock_count:shortage' | 'stock_count:surplus' | 'stock_write_off';
  readonly productId: string;
  readonly locationId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** Head office's value of it (paise); `null` when head office holds no cost — then it is listed, never posted at 0. */
  readonly valueMinor: number | null;
  /** When it happened (decided/applied) — decides the month it belongs to. */
  readonly at: string;
  readonly by: string;
  readonly approvedBy: string | null;
  readonly reason: string;
}

/** A count reconciliation as the books read it (structural subset of the counts register's record). */
export interface CountForBooks {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly varianceMinor: number;
  readonly valueMinor: number;
  readonly adjusted: boolean;
  readonly reasonCode: string;
  readonly counterId: string;
  readonly approvedBy: string | null;
  readonly at: string;
  readonly decidedAt?: string;
  readonly decision?: 'approved' | 'rejected';
  readonly uom?: string;
  readonly movementId?: string | null;
}

/** A write-off as the books read it (structural subset of the write-off register's record). */
export interface WriteOffForBooks {
  readonly id: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qtyRemoved: number;
  readonly uom: string;
  readonly valueMinor: number;
  readonly reasonCode: string;
  readonly lossType: string;
  readonly raisedBy: string;
  readonly approvedBy: string | null;
  readonly at: string;
  readonly valueSource?: 'stock_cost' | 'cost_unknown';
}

/** The stock adjustments that changed stock: an applied count correction (on the ledger), and every write-off. Pure. */
export function stockAdjustmentSources(counts: readonly CountForBooks[], writeOffs: readonly WriteOffForBooks[]): readonly StockAdjustmentSource[] {
  const out: StockAdjustmentSource[] = [];
  for (const c of counts) {
    // Only a correction that was APPLIED moved stock: matched, held or rejected counts post nothing on either ledger.
    if (!c.adjusted || c.varianceMinor === 0 || (c.movementId ?? null) === null || c.decision === 'rejected') continue;
    out.push({
      sourceId: `count:${c.countId}`, kind: c.varianceMinor < 0 ? 'stock_count:shortage' : 'stock_count:surplus',
      productId: c.productId, locationId: c.locationId, quantityMinor: Math.abs(c.varianceMinor), uom: c.uom ?? 'each',
      valueMinor: Math.abs(c.valueMinor) > 0 ? Math.abs(c.valueMinor) : null,
      at: c.decidedAt ?? c.at, by: c.counterId, approvedBy: c.approvedBy, reason: c.reasonCode,
    });
  }
  for (const w of writeOffs) {
    out.push({
      sourceId: `write_off:${w.id}`, kind: 'stock_write_off', productId: w.productId, locationId: w.locationId,
      quantityMinor: w.qtyRemoved, uom: w.uom, valueMinor: w.valueMinor > 0 ? w.valueMinor : null,
      at: w.at, by: w.raisedBy, approvedBy: w.approvedBy, reason: `${w.lossType}: ${w.reasonCode}${w.valueSource === 'cost_unknown' ? ' (value stated by the person — head office held no cost)' : ''}`,
    });
  }
  return out;
}

/** A stock-adjustment voucher: a finance journal that names the source it posts. */
export interface StockAdjustmentJournal extends JournalEntry {
  readonly stockAdjustment: { readonly sourceId: string; readonly kind: string; readonly valueMinor: number; readonly belongsTo?: string };
}

/** Suggested rules (the CA commits their own) — defined with the suggested mapping, re-exported here. */
export { STOCK_ADJUSTMENT_POSTING_RULES } from '../../../packages/finance/src/day-book';

// ── 3. Account classes and the period P&L ────────────────────────────────────────────────────────────────────────

export type AccountClass = 'income' | 'expense' | 'asset' | 'liability' | 'equity';
export const ACCOUNT_CLASSES: readonly AccountClass[] = ['income', 'expense', 'asset', 'liability', 'equity'];

/** A SUGGESTED class for every account the suggested mapping names — the accountant PUTs these (or their own). */
export const SUGGESTED_ACCOUNT_CLASSES: Readonly<Record<string, AccountClass>> = Object.freeze({
  sales_revenue: 'income', display_funding_income: 'income', inventory_gain: 'income',
  inventory_loss: 'expense', inventory_write_off: 'expense', loyalty_expense: 'expense', cost_of_goods_sold: 'expense',
  purchases_grni: 'liability', supplier_payable: 'liability', store_credit_liability: 'liability', loyalty_points_liability: 'liability',
  gst_output_cgst: 'liability', gst_output_sgst: 'liability', gst_output: 'liability', exchange_credit_clearing: 'liability',
  gst_input_cgst: 'asset', gst_input_sgst: 'asset', gst_input_igst: 'asset', inventory: 'asset', cash_in_hand: 'asset',
  card_receivable: 'asset', upi_receivable: 'asset', online_payment_clearing: 'asset', cod_receivable: 'asset',
  trade_receivables: 'asset', bank_clearing: 'asset', bank_receipts_clearing: 'asset', sales_clearing: 'asset',
  opening_balances: 'equity',
});

export interface ProfitAndLoss {
  readonly period: string;
  readonly income: readonly { readonly account: string; readonly amountMinor: number }[];
  readonly expenses: readonly { readonly account: string; readonly amountMinor: number }[];
  readonly totalIncomeMinor: number;
  readonly totalExpensesMinor: number;
  /** Income less expenses — the profit (negative: a loss) on what the books hold. */
  readonly netMinor: number;
  /** Accounts posted to in the month that have no class — the statement is incomplete while any is listed. */
  readonly unclassified: readonly { readonly account: string; readonly netDebitMinor: number }[];
  readonly complete: boolean;
  readonly journals: number;
  /** What the books do not yet carry, in words — never a silent gap. */
  readonly notInTheBooks: readonly string[];
}

/** The month's P&L from its journals and the account classes. Pure. */
export function profitAndLoss(period: string, journals: readonly JournalEntry[], classes: Readonly<Record<string, AccountClass>>): ProfitAndLoss {
  const inMonth = journals.filter((j) => j.period === period);
  const net = new Map<string, number>(); // debit − credit per account
  for (const j of inMonth) for (const l of j.lines) net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + l.debitMinor - l.creditMinor);
  const accounts = [...net.keys()].sort();
  const income = accounts.filter((a) => classes[a] === 'income').map((a) => ({ account: a, amountMinor: -(net.get(a) ?? 0) }));
  const expenses = accounts.filter((a) => classes[a] === 'expense').map((a) => ({ account: a, amountMinor: net.get(a) ?? 0 }));
  const unclassified = accounts.filter((a) => classes[a] === undefined).map((a) => ({ account: a, netDebitMinor: net.get(a) ?? 0 }));
  const totalIncomeMinor = income.reduce((s, x) => s + x.amountMinor, 0);
  const totalExpensesMinor = expenses.reduce((s, x) => s + x.amountMinor, 0);
  const hasCostOfSales = accounts.some((a) => a === 'cost_of_goods_sold');
  return {
    period, income, expenses, totalIncomeMinor, totalExpensesMinor, netMinor: totalIncomeMinor - totalExpensesMinor,
    unclassified, complete: unclassified.length === 0, journals: inMonth.length,
    notInTheBooks: hasCostOfSales ? [] : [
      'Cost of goods sold: the stock ledger values every sale at weighted-average cost (the margin on the Today screen and in head office profitability), but no cost-of-sales or purchase-to-inventory journal is posted to the books yet — how the books carry inventory (perpetual journals or a period-end stock adjustment) is the CA\'s decision. Until then this statement is sales and the posted gains, losses and write-offs, not gross margin.',
    ],
  };
}

// ── 2. The close's book-to-register checks ───────────────────────────────────────────────────────────────────────

/** The month's stock adjustments on the registers against the journals the books hold for them. Pure. */
export function stockAdjustmentCheck(period: string, sources: readonly StockAdjustmentSource[], journals: readonly StockAdjustmentJournal[]): { readonly check: ControlTotalCheck | null; readonly unposted: readonly string[]; readonly unvalued: readonly string[] } {
  const mine = sources.filter((s) => s.at.slice(0, 7) === period);
  if (mine.length === 0) return { check: null, unposted: [], unvalued: [] };
  const posted = new Map(journals.map((j) => [j.stockAdjustment.sourceId, j.stockAdjustment.valueMinor]));
  return {
    check: {
      name: `Count differences and write-offs for ${period}`,
      leftMinor: mine.reduce((n, s) => n + (s.valueMinor ?? 0), 0),
      rightMinor: mine.reduce((n, s) => n + (posted.get(s.sourceId) ?? 0), 0),
      leftDerivation: 'the stock registers: every applied count difference (valued at head office\'s own cost) and every write-off on the register',
      rightDerivation: 'the finance ledger: the stock-adjustment journals posted for those counts and write-offs',
    },
    unposted: mine.filter((s) => !posted.has(s.sourceId)).map((s) => s.sourceId),
    unvalued: mine.filter((s) => s.valueMinor === null).map((s) => s.sourceId),
  };
}

export interface PeriodBooksDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  readonly counts: (tenantId: string) => Promise<readonly CountForBooks[]>;
  readonly writeOffs: (tenantId: string) => Promise<readonly WriteOffForBooks[]>;
  readonly stockAdjustmentJournals: (tenantId: string) => Promise<readonly StockAdjustmentJournal[]>;
  readonly journals: (tenantId: string) => Promise<readonly JournalEntry[]>;
  readonly accountClasses: (tenantId: string) => Promise<Readonly<Record<string, AccountClass>> | undefined>;
  readonly defineAccountClasses: (tenantId: string, classes: Readonly<Record<string, AccountClass>>, by: string) => Promise<void>;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const badPeriod = (period: string) => apiError(400, { code: 'bad_period', whatHappened: `'${period}' is not a month (YYYY-MM).`, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as YYYY-MM.' });

export function periodBooksRoutes(deps: PeriodBooksDeps): readonly Route[] {
  const position = async (t: string) => {
    const [counts, writeOffs, journals] = await Promise.all([deps.counts(t), deps.writeOffs(t), deps.stockAdjustmentJournals(t)]);
    const sources = stockAdjustmentSources(counts, writeOffs);
    const posted = new Set(journals.map((j) => j.stockAdjustment.sourceId));
    return { sources, journals, unposted: sources.filter((s) => !posted.has(s.sourceId)) };
  };
  return [
    {
      // Post every count difference and write-off the books do not hold yet. Nothing to send: the figures are the registers'.
      api: 'API-09', method: 'POST', path: '/v1/finance/stock-adjustments/post',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const map = await deps.postingMap(t);
        if (map === undefined) {
          throw apiError(409, {
            code: 'posting_map_not_defined',
            whatHappened: 'No ledger mapping has been defined for this shop, so no count difference or write-off can post — which account a stock loss goes to is the accountant\'s decision.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant defines the mapping first (PUT /v1/finance/posting-map; GET it for a suggested starting map with the stock-adjustment rules). Nothing was posted.',
          });
        }
        const [{ unposted }, states] = await Promise.all([position(t), deps.periodStates(t)]);
        const appended: StockAdjustmentJournal[] = [];
        const exceptions: { readonly sourceId: string; readonly kind: string; readonly reason: string; readonly detail: string }[] = [];
        for (const s of unposted) {
          if (s.valueMinor === null) {
            exceptions.push({ sourceId: s.sourceId, kind: s.kind, reason: 'value_not_known', detail: `${s.sourceId}: head office holds no cost for ${s.productId} at ${s.locationId}, so the difference cannot be valued — it is not posted at zero. Record the product's cost, then post again.` });
            continue;
          }
          let mapped;
          try {
            mapped = postMapped({ id: s.sourceId, kind: s.kind, at: s.at, currency: 'INR', components: { amount: s.valueMinor } }, map);
          } catch (err) {
            const reason = err instanceof UnmappedKindError ? 'unmapped_kind' : err instanceof MissingComponentError ? 'missing_component' : err instanceof UnbalancedJournalError ? 'unbalanced_journal' : 'not_posted';
            exceptions.push({ sourceId: s.sourceId, kind: s.kind, reason, detail: err instanceof Error ? err.message : String(err) });
            continue;
          }
          const belongsTo = s.at.slice(0, 7);
          const closed = states.get(belongsTo) === 'closed';
          const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
          const what = s.kind === 'stock_write_off' ? 'Stock written off' : s.kind === 'stock_count:shortage' ? 'Stock count shortage' : 'Stock count surplus';
          const journal: StockAdjustmentJournal = {
            entryId: `stock-adjustment:${s.sourceId}`, period, documentDate: s.at.slice(0, 10),
            narrative: `${what} — ${s.sourceId}: ${s.productId} ${s.quantityMinor} ${s.uom} at ${s.locationId}, worth ${s.valueMinor} minor units, by ${s.by}${s.approvedBy === null ? '' : `, approved by ${s.approvedBy}`} (${s.reason})`
              + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
            lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
            postedBy: ctx.userId,
            stockAdjustment: { sourceId: s.sourceId, kind: s.kind, valueMinor: s.valueMinor, ...(closed ? { belongsTo } : {}) },
          };
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) { exceptions.push({ sourceId: s.sourceId, kind: s.kind, reason: gate.refusedBecause ?? 'not_posted', detail: gate.detail }); continue; }
          await deps.appendJournal(t, journal);
          appended.push(journal);
        }
        return { status: appended.length > 0 ? 201 : 200, body: { posted: appended, exceptions, asAt: deps.now() } };
      },
    },
    {
      // Every count difference and write-off: what posted, and what has not (visible until it does).
      api: 'API-09', method: 'GET', path: '/v1/finance/stock-adjustments',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const p = await position(ctx.tenantId);
        return {
          status: 200,
          body: {
            sources: p.sources, journals: p.journals, unposted: p.unposted.map((s) => s.sourceId),
            unvalued: p.sources.filter((s) => s.valueMinor === null).map((s) => s.sourceId),
            valueMinor: p.sources.reduce((n, s) => n + (s.valueMinor ?? 0), 0),
            postedValueMinor: p.journals.reduce((n, j) => n + j.stockAdjustment.valueMinor, 0),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // The accountant's account classes (income / expense / asset / liability / equity) — what the P&L reads. With none
      // defined, the suggested set for the suggested mapping is returned beside `defined: false`.
      api: 'API-09', method: 'GET', path: '/v1/finance/account-classes',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const defined = await deps.accountClasses(ctx.tenantId);
        return { status: 200, body: { defined: defined !== undefined, classes: defined ?? {}, suggested: SUGGESTED_ACCOUNT_CLASSES } };
      },
    },
    {
      api: 'API-09', method: 'PUT', path: '/v1/finance/account-classes',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { classes?: unknown };
        const c = b.classes;
        const ok = c !== null && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0
          && Object.entries(c as Record<string, unknown>).every(([k, v]) => k.trim() !== '' && ACCOUNT_CLASSES.includes(v as AccountClass));
        if (!ok) {
          throw apiError(400, {
            code: 'not_readable_as_account_classes',
            whatHappened: 'Account classes are { classes: { "<account>": "income" | "expense" | "asset" | "liability" | "equity", … } } — at least one.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send each account with its class (GET this route for a suggested set). Nothing was changed.',
          });
        }
        await deps.defineAccountClasses(ctx.tenantId, c as Record<string, AccountClass>, ctx.userId);
        return { status: 200, body: { classes: c, definedBy: ctx.userId, at: deps.now() } };
      },
    },
    {
      // The month's profit and loss, from the journals posted to it (WF-18 "→ P&L"). A read; nothing posts.
      api: 'API-09', method: 'GET', path: '/v1/finance/periods/:period/profit-and-loss',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        if (!PERIOD.test(period)) throw badPeriod(period);
        const classes = await deps.accountClasses(ctx.tenantId);
        if (classes === undefined) {
          throw apiError(409, {
            code: 'account_classes_not_defined',
            whatHappened: 'No account classes are defined, so the books cannot say which accounts are income and which are expenses — that is the accountant\'s decision.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant defines them first (PUT /v1/finance/account-classes; GET it for a suggested set). Nothing was changed.',
          });
        }
        const [journals, states] = await Promise.all([deps.journals(ctx.tenantId), deps.periodStates(ctx.tenantId)]);
        const pl = profitAndLoss(period, journals, classes);
        return { status: 200, body: { ...pl, periodState: states.get(period) ?? 'open', asAt: deps.now() } };
      },
    },
  ];
}
