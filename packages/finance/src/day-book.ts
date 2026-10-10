// M23-FR-01 — the day book: a trading day's synced sales and returns, mapped to balanced journals.
//
// The roadmap's acceptance is one line: **every operational event maps to a journal or an exception.**
// This is the engine that makes that true for the two operational streams the tills produce every day —
// sales and returns. It reads them, pulls the GST out of the MRP-inclusive totals (A9: taxable + tax ==
// gross to the paisa), sums the day per posting KIND, and hands each kind to the mapping-driven posting
// engine (`posting.ts`), which either produces a balanced double-entry journal or refuses with a named
// reason. Nothing here decides which account anything goes to — that is the CA's mapping (AVR-09) — and
// nothing here is ever silently dropped (P-08): a sale whose GST rate nobody knows, a return that cannot
// be split, a tender kind the mapping does not name — each is a VISIBLE exception naming its sources.
//
// Why a day book rather than a journal per receipt: a hypermarket banks thousands of receipts a day, and
// the accounts want the day (one sales voucher, one voucher per tender kind), with the receipts listed
// under it — which is also what Tally imports. Every journal carries the ids of the sources it covers, so
// "which receipts is this figure made of?" is a read, never a reconstruction, and a re-run posts only what
// no journal covers yet: a source fixed after the day's posting lands in a supplementary journal, once.
//
// Finance reads the operational ledger; it never edits it (§28). Corrections are journals.

import { postJournal, type PostingInput, type PostingMap, type JournalEntry as PostedJournal } from './posting';
import { extractInclusiveGst } from './inclusive-tax';
import { PAYABLES_POSTING_RULES } from './payables';
import type { CurrencyCode } from '../../contracts/src/money';

export type DayBookSourceKind = 'sale' | 'return' | 'loyalty';

/**
 * A loyalty fact of the day, valued (PF-09 step 3 · M17-FR-01 "liability updated (M23)"): points a sale EARNED are the
 * shop's new liability; points a return TOOK BACK release it. Valued at the point value in force when they were earned.
 * The day book sums them per kind (`loyalty:earn`, `loyalty:takeback`); which accounts they post to is the CA's mapping.
 * (Points SPENT at the till are a tender — `tender:loyalty_points` — and store credit issued on a refund is
 * `refund:store_credit`; both already post through the sale and return streams.)
 */
export interface DayBookLoyalty {
  /** `earn:<saleId>` or `takeback:<returnId>` — one per fact, so a re-run posts each once. */
  readonly sourceId: string;
  readonly kind: 'earn' | 'takeback';
  readonly points: number;
  readonly valueMinor: number;
}

/** A synced sale as the day book needs it — a structural subset of the till's `IncomingSale`. */
export interface DayBookSaleLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly lineTotalMinor: number;
  /** The GST rate the lane charged, frozen at the time of supply. Wins over the catalogue's rate. */
  readonly taxRateBps?: number;
}
export interface DayBookTender {
  readonly kind: string;
  readonly amountMinor: number;
}
export interface DayBookSale {
  readonly saleId: string;
  readonly tradingDay: string;
  readonly totalMinor: number;
  readonly lines: readonly DayBookSaleLine[];
  readonly tenders: readonly DayBookTender[];
}

/** A recorded return as the day book needs it — a structural subset of the desk's `ReturnRecord`. */
export interface DayBookReturnLine {
  readonly productId: string;
  readonly quantityMinor: number;
}
export interface DayBookExchange {
  /** The returned value applied against the replacement sale (its `exchange_credit` tender). */
  readonly appliedMinor: number;
  readonly balance: 'even' | 'refund' | 'top_up';
  readonly balanceMinor: number;
  readonly balanceTender?: string;
}
export interface DayBookReturn {
  readonly returnId: string;
  readonly originalSaleId: string | null;
  readonly refundMinor: number;
  readonly refundTender: string;
  readonly lines: readonly DayBookReturnLine[];
  readonly exchange?: DayBookExchange;
  /**
   * OB-34 "A": the value of the points the member PAID WITH that this return gave back to them (head office's give-back
   * fact). It is part of the returned goods' value — so the sales return reverses revenue and GST on the whole of it — and
   * it leaves the shop as a `refund:loyalty_points` leg (the points liability is owed again), not as money.
   */
  readonly pointsGivenBackMinor?: number;
}

export type DayBookExceptionReason =
  /** A line has no GST rate on it and the catalogue does not know one for the product. */
  | 'tax_rate_unknown'
  /** The inclusive-GST split refused the line (e.g. an intra-State rate that does not halve). */
  | 'tax_split_failed'
  | 'negative_line'
  | 'lines_do_not_sum_to_total'
  | 'tenders_do_not_sum_to_total'
  /** A receipt-less return whose lines carry different GST rates — nothing to weight the refund by. */
  | 'refund_split_unknown'
  /** The mapping has no rule for this posting kind (e.g. a tender kind the CA has not mapped). */
  | 'unmapped_kind'
  | 'missing_component'
  | 'unbalanced_journal';

export interface DayBookException {
  readonly sourceKind: DayBookSourceKind;
  /** Every source document the exception holds back — one for a per-receipt problem, the day's list for a rule problem. */
  readonly sourceIds: readonly string[];
  /** The posting kind, when the exception is about a mapping rule rather than a receipt. */
  readonly kind?: string;
  readonly reason: DayBookExceptionReason;
  readonly detail: string;
}

/** The money in a sale or return once GST has been pulled out of the inclusive totals (minor units). */
export interface TaxSplit {
  readonly total: number;
  readonly net: number;
  readonly tax: number;
  readonly cgst: number;
  readonly sgst: number;
}

/** One posting kind's total for the day and the sources it is made of. */
export interface DayBookAggregate {
  readonly kind: string;
  readonly sourceKind: DayBookSourceKind;
  readonly sourceIds: readonly string[];
  readonly components: Readonly<Record<string, number>>;
}

export interface DayBookInput {
  readonly tradingDay: string;
  readonly sales: readonly DayBookSale[];
  readonly returns: readonly DayBookReturn[];
  /** The original sales the day's returns point at, by saleId — what a multi-rate refund is weighted by. */
  readonly originalSales: ReadonlyMap<string, DayBookSale>;
  /** The catalogue's GST rate for a product (basis points), or nothing. */
  readonly taxRateOf: (productId: string) => number | undefined;
  /**
   * Per posting KIND, the source ids a posted day-book journal of that kind already covers — never posted
   * twice. Per kind, not per receipt: a sale whose voucher posted while its tender kind was unmapped still
   * owes its tender leg, and posts exactly that leg once the mapping names the kind.
   */
  readonly alreadyPosted: ReadonlyMap<string, ReadonlySet<string>>;
  /** The day's valued loyalty facts (PF-09 step 3). Absent → none. */
  readonly loyalty?: readonly DayBookLoyalty[];
}

export interface DayBook {
  readonly tradingDay: string;
  readonly aggregates: readonly DayBookAggregate[];
  readonly exceptions: readonly DayBookException[];
  /** Sources every one of whose legs an earlier posting of this day already covers. */
  readonly skipped: readonly string[];
  /** Sources that carried no money at all (a zero-value return) — nothing to post, and said so. */
  readonly zeroValue: readonly string[];
  readonly counted: { readonly sales: number; readonly returns: number; readonly loyalty?: number };
}

const ZERO: TaxSplit = { total: 0, net: 0, tax: 0, cgst: 0, sgst: 0 };

const addSplit = (a: TaxSplit, b: TaxSplit): TaxSplit => ({
  total: a.total + b.total, net: a.net + b.net, tax: a.tax + b.tax, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst,
});

/** Pull intra-State GST (CGST + SGST) out of an inclusive amount. Retail over the counter is intra-State. */
export function splitInclusive(amountMinor: number, rateBps: number): TaxSplit {
  if (amountMinor === 0) return ZERO;
  if (rateBps === 0) return { total: amountMinor, net: amountMinor, tax: 0, cgst: 0, sgst: 0 };
  const b = extractInclusiveGst({ mrpMinor: amountMinor, rateBps, placeOfSupply: 'intra_state' });
  const part = (name: 'CGST' | 'SGST'): number => b.components.find((c) => c.component === name)?.amountMinor ?? 0;
  return { total: b.grossMinor, net: b.taxableMinor, tax: b.totalTaxMinor, cgst: part('CGST'), sgst: part('SGST') };
}

type Split =
  | { readonly ok: true; readonly split: TaxSplit }
  | { readonly ok: false; readonly reason: DayBookExceptionReason; readonly detail: string };

const refuse = (reason: DayBookExceptionReason, detail: string): Split => ({ ok: false, reason, detail });

function splitSale(sale: DayBookSale, taxRateOf: DayBookInput['taxRateOf']): Split {
  if (sale.lines.length === 0) {
    return refuse('tax_rate_unknown', `sale ${sale.saleId} carries no lines, so there is nothing to derive its GST from`);
  }
  let lineSum = 0;
  let acc = ZERO;
  for (const line of sale.lines) {
    if (!Number.isInteger(line.lineTotalMinor) || line.lineTotalMinor < 0) {
      return refuse('negative_line', `sale ${sale.saleId}: line ${line.productId} totals ${line.lineTotalMinor} — a sale line cannot be negative`);
    }
    lineSum += line.lineTotalMinor;
    const rate = line.taxRateBps ?? taxRateOf(line.productId);
    if (rate === undefined) {
      return refuse('tax_rate_unknown', `sale ${sale.saleId}: ${line.productId} has no GST rate on the line and none in the catalogue`);
    }
    try {
      acc = addSplit(acc, splitInclusive(line.lineTotalMinor, rate));
    } catch (err) {
      return refuse('tax_split_failed', `sale ${sale.saleId}: ${line.productId} at ${rate} bps — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (lineSum !== sale.totalMinor) {
    return refuse('lines_do_not_sum_to_total', `sale ${sale.saleId}: the lines add to ${lineSum} against a total of ${sale.totalMinor}`);
  }
  const tendered = sale.tenders.reduce((t, x) => t + x.amountMinor, 0);
  if (tendered !== sale.totalMinor) {
    return refuse('tenders_do_not_sum_to_total', `sale ${sale.saleId}: the tenders add to ${tendered} against a total of ${sale.totalMinor}`);
  }
  return { ok: true, split: acc };
}

/** The value a return credits back: the refund, or on an exchange what was applied plus any refunded balance. */
export function returnedValue(ret: DayBookReturn): number {
  const points = Math.max(0, ret.pointsGivenBackMinor ?? 0);
  if (ret.exchange === undefined) return ret.refundMinor + points;
  return ret.exchange.appliedMinor + (ret.exchange.balance === 'refund' ? ret.exchange.balanceMinor : 0) + points;
}

/** How the returned value left the shop — by which tender, how much. */
export function refundLegs(ret: DayBookReturn): readonly DayBookTender[] {
  const points: readonly DayBookTender[] = (ret.pointsGivenBackMinor ?? 0) > 0 ? [{ kind: 'loyalty_points', amountMinor: ret.pointsGivenBackMinor! }] : [];
  if (ret.exchange === undefined) {
    return [...(ret.refundMinor > 0 ? [{ kind: ret.refundTender, amountMinor: ret.refundMinor }] : []), ...points];
  }
  const legs: DayBookTender[] = [];
  if (ret.exchange.appliedMinor > 0) legs.push({ kind: 'exchange_credit', amountMinor: ret.exchange.appliedMinor });
  if (ret.exchange.balance === 'refund' && ret.exchange.balanceMinor > 0) {
    legs.push({ kind: ret.exchange.balanceTender ?? ret.refundTender, amountMinor: ret.exchange.balanceMinor });
  }
  return [...legs, ...points];
}

function splitReturn(ret: DayBookReturn, original: DayBookSale | undefined, taxRateOf: DayBookInput['taxRateOf']): Split {
  const value = returnedValue(ret);
  if (value === 0) return { ok: true, split: ZERO };
  if (ret.lines.length === 0) {
    return refuse('tax_rate_unknown', `return ${ret.returnId} carries no lines, so there is nothing to derive its GST from`);
  }
  const originalByProduct = new Map((original?.lines ?? []).map((l) => [l.productId, l] as const));
  const rates: number[] = [];
  for (const line of ret.lines) {
    const rate = originalByProduct.get(line.productId)?.taxRateBps ?? taxRateOf(line.productId);
    if (rate === undefined) {
      return refuse('tax_rate_unknown', `return ${ret.returnId}: ${line.productId} has no GST rate on the original sale and none in the catalogue`);
    }
    rates.push(rate);
  }
  try {
    if (new Set(rates).size === 1) {
      return { ok: true, split: splitInclusive(value, rates[0]!) };
    }
    if (original === undefined) {
      return refuse('refund_split_unknown', `return ${ret.returnId}: its lines carry different GST rates and there is no original sale to weight the refund by`);
    }
    // Weight each line by the returned portion's value at the ORIGINAL price (per-unit incl × qty returned).
    const weights = ret.lines.map((l) => {
      const o = originalByProduct.get(l.productId);
      const perUnit = o !== undefined && o.quantityMinor > 0 ? o.lineTotalMinor / o.quantityMinor : 0;
      return Math.max(0, Math.round(perUnit * l.quantityMinor));
    });
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    if (totalWeight <= 0) {
      return refuse('refund_split_unknown', `return ${ret.returnId}: none of its lines is priced on the original sale, so the refund cannot be weighted`);
    }
    let allocated = 0;
    let acc = ZERO;
    ret.lines.forEach((_, i) => {
      const part = i === ret.lines.length - 1 ? value - allocated : Math.round((value * weights[i]!) / totalWeight);
      allocated += part;
      if (part > 0) acc = addSplit(acc, splitInclusive(part, rates[i]!));
    });
    return { ok: true, split: acc };
  } catch (err) {
    return refuse('tax_split_failed', `return ${ret.returnId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface Accumulator {
  readonly kind: string;
  readonly sourceKind: DayBookSourceKind;
  readonly sourceIds: string[];
  readonly components: Record<string, number>;
}

/** Sum the day per posting kind. Pure. Every input ends up in an aggregate, an exception, `skipped` or `zeroValue`. */
export function buildDayBook(input: DayBookInput): DayBook {
  const acc = new Map<string, Accumulator>();
  const add = (kind: string, sourceKind: DayBookSourceKind, sourceId: string, components: Readonly<Record<string, number>>): void => {
    const a = acc.get(kind) ?? { kind, sourceKind, sourceIds: [], components: {} };
    if (!a.sourceIds.includes(sourceId)) a.sourceIds.push(sourceId);
    for (const [name, value] of Object.entries(components)) a.components[name] = (a.components[name] ?? 0) + value;
    acc.set(kind, a);
  };
  const exceptions: DayBookException[] = [];
  const skipped: string[] = [];
  const touched: string[] = [];
  const covered = (kind: string, sourceId: string): boolean => input.alreadyPosted.get(kind)?.has(sourceId) === true;

  for (const sale of input.sales) {
    const tenders = sale.tenders.filter((t) => t.amountMinor !== 0);
    const kinds = ['sale', ...tenders.map((t) => `tender:${t.kind}`)];
    if (kinds.every((k) => covered(k, sale.saleId))) { skipped.push(sale.saleId); continue; }
    const s = splitSale(sale, input.taxRateOf);
    if (!s.ok) { exceptions.push({ sourceKind: 'sale', sourceIds: [sale.saleId], reason: s.reason, detail: s.detail }); continue; }
    touched.push(sale.saleId);
    if (!covered('sale', sale.saleId)) add('sale', 'sale', sale.saleId, { ...s.split });
    for (const t of tenders) {
      if (!covered(`tender:${t.kind}`, sale.saleId)) add(`tender:${t.kind}`, 'sale', sale.saleId, { amount: t.amountMinor });
    }
  }
  for (const ret of input.returns) {
    const legs = refundLegs(ret);
    const kinds = ['sale_return', ...legs.map((l) => `refund:${l.kind}`)];
    if (kinds.every((k) => covered(k, ret.returnId))) { skipped.push(ret.returnId); continue; }
    const original = ret.originalSaleId === null ? undefined : input.originalSales.get(ret.originalSaleId);
    const s = splitReturn(ret, original, input.taxRateOf);
    if (!s.ok) { exceptions.push({ sourceKind: 'return', sourceIds: [ret.returnId], reason: s.reason, detail: s.detail }); continue; }
    touched.push(ret.returnId);
    if (!covered('sale_return', ret.returnId)) add('sale_return', 'return', ret.returnId, { ...s.split });
    for (const leg of legs) {
      if (!covered(`refund:${leg.kind}`, ret.returnId)) add(`refund:${leg.kind}`, 'return', ret.returnId, { amount: leg.amountMinor });
    }
  }

  for (const l of input.loyalty ?? []) {
    const kind = `loyalty:${l.kind}`;
    if (covered(kind, l.sourceId)) { skipped.push(l.sourceId); continue; }
    touched.push(l.sourceId);
    if (l.valueMinor !== 0) add(kind, 'loyalty', l.sourceId, { amount: l.valueMinor });
  }

  const aggregates = [...acc.values()]
    .filter((a) => Object.values(a.components).some((v) => v !== 0))
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map((a) => ({ kind: a.kind, sourceKind: a.sourceKind, sourceIds: [...a.sourceIds], components: { ...a.components } }));
  const inAnAggregate = new Set(aggregates.flatMap((a) => a.sourceIds));
  const zeroValue = touched.filter((id) => !inAnAggregate.has(id));
  return {
    tradingDay: input.tradingDay, aggregates, exceptions, skipped, zeroValue,
    counted: { sales: input.sales.length, returns: input.returns.length, ...(input.loyalty === undefined ? {} : { loyalty: input.loyalty.length }) },
  };
}

export interface DayBookPosting {
  readonly aggregate: DayBookAggregate;
  readonly entry: PostedJournal;
}

/** Hand each aggregate to the mapping-driven engine: a balanced journal each, or a named exception each. */
export function postDayBook(book: DayBook, map: PostingMap, currency: CurrencyCode): {
  readonly journals: readonly DayBookPosting[];
  readonly exceptions: readonly DayBookException[];
} {
  const journals: DayBookPosting[] = [];
  const exceptions: DayBookException[] = [];
  for (const aggregate of book.aggregates) {
    const input: PostingInput = {
      id: `${aggregate.kind}@${book.tradingDay}`, kind: aggregate.kind,
      at: `${book.tradingDay}T00:00:00.000Z`, currency, components: aggregate.components,
    };
    try {
      journals.push({ aggregate, entry: postJournal(input, map) });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      const reason: DayBookExceptionReason =
        name === 'UnmappedKindError' ? 'unmapped_kind'
          : name === 'MissingComponentError' ? 'missing_component'
            : 'unbalanced_journal';
      const message = err instanceof Error ? err.message : String(err);
      exceptions.push({
        sourceKind: aggregate.sourceKind, sourceIds: aggregate.sourceIds, kind: aggregate.kind, reason,
        detail: `${aggregate.kind} for ${book.tradingDay} (${aggregate.sourceIds.length} source(s)) could not be posted: ${message}`,
      });
    }
  }
  return { journals, exceptions };
}

/** What the accountant's mapping may be. Shape-checked here; WHICH accounts is the CA's call, never ours. */
export function validatePostingMap(candidate: unknown): { readonly ok: true; readonly map: PostingMap } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const rules = (candidate as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    return { ok: false, problems: ['the mapping needs a non-empty `rules` list — one rule per posting kind'] };
  }
  const kinds = new Set<string>();
  rules.forEach((r, i) => {
    const rule = r as { kind?: unknown; legs?: unknown };
    if (typeof rule.kind !== 'string' || rule.kind.trim() === '') { problems.push(`rule ${i + 1}: needs a \`kind\``); return; }
    if (kinds.has(rule.kind)) problems.push(`rule ${i + 1}: kind '${rule.kind}' is mapped twice`);
    kinds.add(rule.kind);
    if (!Array.isArray(rule.legs) || rule.legs.length < 2) { problems.push(`rule '${rule.kind}': needs at least two legs (a debit and a credit)`); return; }
    let debits = 0;
    let credits = 0;
    rule.legs.forEach((l, j) => {
      const leg = l as { account?: unknown; side?: unknown; component?: unknown };
      if (typeof leg.account !== 'string' || leg.account.trim() === '') problems.push(`rule '${rule.kind}' leg ${j + 1}: needs an \`account\``);
      if (typeof leg.component !== 'string' || leg.component.trim() === '') problems.push(`rule '${rule.kind}' leg ${j + 1}: needs a \`component\``);
      if (leg.side === 'debit') debits += 1;
      else if (leg.side === 'credit') credits += 1;
      else problems.push(`rule '${rule.kind}' leg ${j + 1}: \`side\` must be 'debit' or 'credit'`);
    });
    if (debits === 0 || credits === 0) problems.push(`rule '${rule.kind}': needs at least one debit leg and one credit leg`);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, map: { rules: rules as PostingMap['rules'] } };
}

/**
 * A SUGGESTED starting mapping for an Indian retail day book — a clearing-account pattern. The sale
 * voucher debits `sales_clearing` for the day's takings and credits revenue and output GST; each tender
 * kind's voucher debits its own account and credits the clearing, so a day whose tenders cover its sales
 * leaves the clearing at zero — and a day that does not shows the difference, in the accounts, as a
 * balance (P-08). Returns and refunds are the mirror image.
 *
 * It is a suggestion: the accountant PUTs it (or their own) before anything posts (AVR-09, P-05).
 */
export const DEFAULT_RETAIL_POSTING_MAP: PostingMap = {
  rules: [
    {
      kind: 'sale',
      legs: [
        { account: 'sales_clearing', side: 'debit', component: 'total' },
        { account: 'sales_revenue', side: 'credit', component: 'net' },
        { account: 'gst_output_cgst', side: 'credit', component: 'cgst' },
        { account: 'gst_output_sgst', side: 'credit', component: 'sgst' },
      ],
    },
    {
      kind: 'sale_return',
      legs: [
        { account: 'sales_revenue', side: 'debit', component: 'net' },
        { account: 'gst_output_cgst', side: 'debit', component: 'cgst' },
        { account: 'gst_output_sgst', side: 'debit', component: 'sgst' },
        { account: 'sales_clearing', side: 'credit', component: 'total' },
      ],
    },
    // FUL-05: an online order's sale is paid by its prepayment (`online_prepaid`, held by the payment provider until it
    // settles) or by the door's cash / UPI, and a cash-on-delivery remainder the customer still owes is `cod_due`.
    ...(['cash', 'card', 'upi', 'store_credit', 'exchange_credit', 'loyalty_points', 'online_prepaid', 'cod_due'] as const).flatMap((tender) => {
      const account = tender === 'cash' ? 'cash_in_hand'
        : tender === 'card' ? 'card_receivable'
          : tender === 'upi' ? 'upi_receivable'
            : tender === 'store_credit' ? 'store_credit_liability'
              // PF-09 step 3: points spent at the till reduce what the shop owes its members.
              : tender === 'loyalty_points' ? 'loyalty_points_liability'
                : tender === 'online_prepaid' ? 'online_payment_clearing'
                  : tender === 'cod_due' ? 'cod_receivable'
                    : 'exchange_credit_clearing';
      return [
        {
          kind: `tender:${tender}`,
          legs: [
            { account, side: 'debit' as const, component: 'amount' },
            { account: 'sales_clearing', side: 'credit' as const, component: 'amount' },
          ],
        },
        {
          kind: `refund:${tender}`,
          legs: [
            { account: 'sales_clearing', side: 'debit' as const, component: 'amount' },
            { account, side: 'credit' as const, component: 'amount' },
          ],
        },
      ];
    }),
    // PF-09 step 3 (M17-FR-01 → M23): points earned are owed to the member; points a return takes back are released.
    // Suggested as an expense against the liability; whether the CA defers revenue instead is the CA's mapping.
    {
      kind: 'loyalty:earn',
      legs: [
        { account: 'loyalty_expense', side: 'debit', component: 'amount' },
        { account: 'loyalty_points_liability', side: 'credit', component: 'amount' },
      ],
    },
    {
      kind: 'loyalty:takeback',
      legs: [
        { account: 'loyalty_points_liability', side: 'debit', component: 'amount' },
        { account: 'loyalty_expense', side: 'credit', component: 'amount' },
      ],
    },
    // Stock confirmed lost when a floor indent's or a transfer's shortfall is resolved (Batch 2's valued loss): suggested as
    // the loss expense against inventory. Whether the CA splits transit loss from shrinkage is the CA's mapping.
    ...(['floor_indent', 'transfer'] as const).map((source) => ({
      kind: `stock_loss:${source}`,
      legs: [
        { account: 'inventory_loss', side: 'debit' as const, component: 'amount' },
        { account: 'inventory', side: 'credit' as const, component: 'amount' },
      ],
    })),
    // SP-7b (M23-FR-01): the supplier account — a matched invoice's payable, its reversal, a debit note — through a
    // goods-received-not-invoiced clearing (`payables.ts`). Suggested like the rest; the accountant commits it.
    ...PAYABLES_POSTING_RULES,
  ],
};
