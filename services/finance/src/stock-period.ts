// API-09 Finance — the month-end stock adjustment (OB-56 "A", owner 11 Oct 2026 · M23 · WF-18 "reconcile stock → period
// close → P&L" · D10-FR-03 · P-08 · hard rule #2).
//
// How the books carry stock for gross margin: once a month, at the close, ONE journal brings the books' inventory account
// to head office's own closing stock value — every product's on-hand at the month end (from the stock ledger) at its
// AVERAGE BUYING COST (OB-39, the same rule the Today margin and head office profitability read) — and books the balance
// as cost of goods sold:
//
//     cost of goods sold  =  stock in the books before the adjustment  +  purchases of the month  −  closing stock value
//
// "Stock in the books before the adjustment" is the inventory account's balance through the month as the books hold it:
// last month's closing stock (last month's adjustment, or the opening trial balance) PLUS this month's count differences,
// write-offs and transfer shortfalls, which already posted Dr loss / Cr inventory (or the reverse). That is why nothing is
// counted twice: a write-off has ALREADY taken its value out of inventory and into its own expense line, and the stock
// ledger's closing figure is already lower by it — so it is in both "before" and "closing" and cancels out of cost of
// goods sold. (The naive "opening + purchases − closing" with last month's closing as opening would book every write-off
// twice: once as the write-off, again inside cost of goods sold.) For the same reason the adjustment is REFUSED while any
// valued count difference, write-off or shortfall of the month (or earlier) is still unposted: posting it later would
// expense it a second time.
//
// Purchases are the month's receipts into the shop's own stock at their own cost (a receipt with no cost at the average;
// goods sent back to a supplier come off at the average), credited to the goods-received clearing the supplier bills
// debit — so that account's balance is what has been received and not yet billed. Opening-load receipts are not purchases
// (the books carry opening stock through the opening trial balance). Consigned and concession stock is not the shop's.
//
// Nothing is valued at zero: a product on hand with no average buying cost is LISTED and the adjustment refused until head
// office holds its cost (P-08). Through the accountant's posting map (kind `stock_period_adjustment`; suggested rule
// shipped, refused `not_mapped` if absent). Once per month: the journal's id is the month, a re-run returns it.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { postJournal as postMapped } from '../../../packages/finance/src/posting';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';

export const STOCK_PERIOD_KIND = 'stock_period_adjustment';

/** One product's closing stock at one store, as head office values it. */
export interface ClosingStockLine {
  readonly productId: string;
  readonly storeId: string;
  readonly onHandMinor: number;
  readonly uom: string;
  /** OB-39 average buying cost per whole unit; `null` when head office holds none — then the line is unvalued. */
  readonly unitCostMinor: number | null;
  readonly valueMinor: number | null;
}

/** What head office's stock ledger says about the month — the figures the adjustment is made from. */
export interface StockValuation {
  readonly period: string;
  readonly closing: readonly ClosingStockLine[];
  readonly closingValueMinor: number;
  /** Lines on hand with no cost — never valued at zero; the adjustment waits for them. */
  readonly unvalued: readonly ClosingStockLine[];
  /** Lines with negative on-hand at the month end — valued as the ledger says, and listed so a person looks. */
  readonly negative: readonly ClosingStockLine[];
  readonly purchases: {
    readonly receivedMinor: number;
    readonly returnedToSupplierMinor: number;
    readonly purchasesMinor: number;
    /** Receipts or returns with no cost and no average to value them at — listed, and the adjustment waits. */
    readonly unvalued: readonly string[];
  };
  /** Opening-load movements of the month (not purchases) — said so the reader can tie the figures out. */
  readonly openingLoadsMinor: number;
}

/** The month's adjustment, worked out. Pure. */
export interface StockPeriodFigures {
  readonly period: string;
  readonly inventoryAccount: string;
  readonly booksInventoryBeforeMinor: number;
  readonly purchasesMinor: number;
  readonly closingValueMinor: number;
  readonly costOfSalesMinor: number;
  /** closing − books: positive raises the inventory account, negative lowers it. */
  readonly inventoryChangeMinor: number;
}

export function stockPeriodFigures(period: string, valuation: StockValuation, journals: readonly JournalEntry[], inventoryAccount: string): StockPeriodFigures {
  const before = journals
    .filter((j) => j.period <= period && j.entryId !== stockPeriodEntryId(period))
    .flatMap((j) => j.lines).filter((l) => l.accountCode === inventoryAccount)
    .reduce((n, l) => n + l.debitMinor - l.creditMinor, 0);
  const purchasesMinor = valuation.purchases.purchasesMinor;
  const closingValueMinor = valuation.closingValueMinor;
  return {
    period, inventoryAccount, booksInventoryBeforeMinor: before, purchasesMinor, closingValueMinor,
    costOfSalesMinor: before + purchasesMinor - closingValueMinor,
    inventoryChangeMinor: closingValueMinor - before,
  };
}

export const stockPeriodEntryId = (period: string): string => `stock-period:${period}`;

/** The month-end adjustment voucher: a finance journal that carries its own figures. */
export interface StockPeriodJournal extends JournalEntry {
  readonly stockPeriod: StockPeriodFigures;
}

/** The accounts the accountant's rule names: the inventory account (its `increase` leg) and cost of sales. */
export function stockPeriodAccounts(map: StoredPostingMap | undefined): { readonly inventory: string; readonly costOfSales: string } | undefined {
  const rule = map?.rules.find((r) => r.kind === STOCK_PERIOD_KIND);
  if (rule === undefined) return undefined;
  const inventory = rule.legs.find((l) => l.component === 'increase')?.account ?? rule.legs.find((l) => l.component === 'decrease')?.account;
  const costOfSales = rule.legs.find((l) => l.component === 'cost_of_sales')?.account;
  return inventory === undefined || costOfSales === undefined ? undefined : { inventory, costOfSales };
}

export interface StockPeriodDeps extends Pick<FinanceDeps, 'periodStates' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  readonly journals: (tenantId: string) => Promise<readonly JournalEntry[]>;
  readonly valuation: (tenantId: string, period: string) => Promise<StockValuation>;
  /** Valued count differences, write-offs and shortfalls of the month or earlier that the books do not hold yet. */
  readonly outstandingStockPostings: (tenantId: string, period: string) => Promise<readonly string[]>;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function stockPeriodRoutes(deps: StockPeriodDeps): readonly Route[] {
  const periodOf = (raw: string | undefined): string => {
    const period = raw ?? '';
    if (!PERIOD.test(period)) throw apiError(400, { code: 'bad_period', whatHappened: `'${period}' is not a month (YYYY-MM).`, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as YYYY-MM.' });
    return period;
  };
  const posted = async (t: string, period: string): Promise<StockPeriodJournal | undefined> =>
    (await deps.journals(t)).find((j): j is StockPeriodJournal => j.entryId === stockPeriodEntryId(period) && 'stockPeriod' in j);

  return [
    {
      // What the adjustment would post (or did): closing stock at average buying cost, purchases, the books' stock, COGS.
      api: 'API-09', method: 'GET', path: '/v1/finance/periods/:period/stock-valuation',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = periodOf(ctx.params['period']);
        const t = ctx.tenantId;
        const [map, valuation, journals, outstanding, done] = await Promise.all([deps.postingMap(t), deps.valuation(t, period), deps.journals(t), deps.outstandingStockPostings(t, period), posted(t, period)]);
        const accounts = stockPeriodAccounts(map);
        return {
          status: 200,
          body: {
            period, valuation, outstandingStockPostings: outstanding,
            figures: done?.stockPeriod ?? (accounts === undefined ? null : stockPeriodFigures(period, valuation, journals, accounts.inventory)),
            mapped: accounts !== undefined, posted: done ?? null, asAt: deps.now(),
          },
        };
      },
    },
    {
      // Post the month's ONE adjustment. Nothing to send: every figure is head office's own.
      api: 'API-09', method: 'POST', path: '/v1/finance/periods/:period/stock-adjustment',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const period = periodOf(ctx.params['period']);
        const t = ctx.tenantId;
        const already = await posted(t, period);
        if (already !== undefined) return { status: 200, body: { posted: already, alreadyPosted: true } };
        const states = await deps.periodStates(t);
        if (states.get(period) === 'closed') {
          throw apiError(409, {
            code: 'period_is_closed',
            whatHappened: `${period} is closed and signed, and has no month-end stock adjustment. A closed month is not changed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: `Reopen ${period} with a second person's approval if its stock must be adjusted, then post it. Nothing was posted.`,
          });
        }
        const map = await deps.postingMap(t);
        const accounts = stockPeriodAccounts(map);
        if (map === undefined || accounts === undefined) {
          throw apiError(409, {
            code: 'not_mapped',
            whatHappened: `The accountant's posting map has no rule for the month-end stock adjustment (${STOCK_PERIOD_KIND}: cost_of_sales, purchases, increase, decrease), so which accounts carry stock and cost of sales is not decided.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant adds the rule (GET /v1/finance/posting-map shows the suggested one), then post again. Nothing was posted.',
          });
        }
        const outstanding = await deps.outstandingStockPostings(t, period);
        if (outstanding.length > 0) {
          throw apiError(409, {
            code: 'stock_postings_outstanding',
            whatHappened: `${outstanding.length} count difference(s), write-off(s) or shortfall(s) of ${period} or earlier are not in the books yet: ${outstanding.join(', ')}. Adjusting now would put them into cost of goods sold, and posting them afterwards would book them a second time.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Post them first (POST /v1/finance/stock-adjustments/post and /v1/finance/stock-losses/post), then the month-end adjustment. Nothing was posted.',
          });
        }
        const [valuation, journals] = await Promise.all([deps.valuation(t, period), deps.journals(t)]);
        if (valuation.unvalued.length > 0 || valuation.purchases.unvalued.length > 0) {
          throw apiError(409, {
            code: 'stock_not_valued',
            whatHappened: `Head office holds no buying cost for ${[...valuation.unvalued.map((l) => `${l.productId} at ${l.storeId} (${l.onHandMinor} ${l.uom} on hand)`), ...valuation.purchases.unvalued].join('; ')}. Stock is never valued at zero, so the month's closing stock cannot be valued.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record the cost (a receipt at its cost), then post again. Nothing was posted.',
          });
        }
        const figures = stockPeriodFigures(period, valuation, journals, accounts.inventory);
        if (figures.costOfSalesMinor < 0) {
          throw apiError(409, {
            code: 'cost_of_sales_negative',
            whatHappened: `The month's cost of goods sold comes out negative (${figures.costOfSalesMinor}): the books held ${figures.booksInventoryBeforeMinor} of stock, ${figures.purchasesMinor} was bought, and ${figures.closingValueMinor} is on hand. More stock than the books and the purchases can explain — usually opening stock that is not in the opening trial balance.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant checks the inventory opening balance against the opening stock load, then post again. Nothing was posted.',
          });
        }
        const at = `${period}-28T00:00:00.000Z`;
        const mapped = postMapped({
          id: stockPeriodEntryId(period), kind: STOCK_PERIOD_KIND, at, currency: 'INR',
          components: {
            cost_of_sales: figures.costOfSalesMinor, purchases: figures.purchasesMinor,
            increase: Math.max(0, figures.inventoryChangeMinor), decrease: Math.max(0, -figures.inventoryChangeMinor),
          },
        }, map);
        const lastDay = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
        const journal: StockPeriodJournal = {
          entryId: stockPeriodEntryId(period), period, documentDate: lastDay,
          narrative: `Month-end stock adjustment for ${period}: stock in the books ${figures.booksInventoryBeforeMinor} + purchases ${figures.purchasesMinor} − closing stock ${figures.closingValueMinor} (on hand at average buying cost) = cost of goods sold ${figures.costOfSalesMinor} minor units`,
          lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
          postedBy: ctx.userId, stockPeriod: figures,
        };
        const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
        if (!gate.ok) throw apiError(422, { code: gate.refusedBecause ?? 'not_posted', whatHappened: gate.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was posted.' });
        await deps.appendJournal(t, journal);
        return { status: 201, body: { posted: journal } };
      },
    },
  ];
}

/** The close's check: the stock ledger's closing value against the inventory account in the books. Pure. */
export function stockValueCheck(period: string, valuation: StockValuation, journals: readonly JournalEntry[], inventoryAccount: string): { readonly name: string; readonly leftMinor: number; readonly rightMinor: number; readonly leftDerivation: string; readonly rightDerivation: string } {
  const books = journals.filter((j) => j.period <= period).flatMap((j) => j.lines).filter((l) => l.accountCode === inventoryAccount).reduce((n, l) => n + l.debitMinor - l.creditMinor, 0);
  return {
    name: `Stock value at the close of ${period}`,
    leftMinor: valuation.closingValueMinor,
    rightMinor: books,
    leftDerivation: `the stock ledger: every product on hand at the end of ${period} at head office's average buying cost${valuation.unvalued.length > 0 ? ` (${valuation.unvalued.length} line(s) with no cost are NOT valued — never at zero)` : ''}`,
    rightDerivation: `the finance ledger: debits less credits on ${inventoryAccount} through ${period}`,
  };
}
