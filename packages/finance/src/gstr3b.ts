// GSTR-3B — the monthly summary return and its reconciliation to the till (R3 · A15 · A16 · A14 · A17 port).
//
// Signed acceptance (OB-188):
//   A15 — "for a month, GSTR-3B Table 3.1 outward taxable value and tax equal the sum of the banked POS sales less
//          returns for that month to the paisa, and equal GSTR-1's totals. Any difference is listed as a named
//          reconciliation exception, never absorbed. Monthly periods only (D2)."
//   A16 — "once GSTR-1 for a period is filed (submission store `filed`), the 3B outward-liability figures are derived
//          from it and any attempt to change them is refused (no override path, guardrail-asserted). A correction goes
//          through the next period's GSTR-1 amendment, recorded as a compensating event."
//
// How it holds together:
//   • GSTR-1's figures for a month are folded from what is STORED: the till's banked sales less the returns processed
//     in the month (the tested `salesToOutwardSupplies` + `netTable12` — the same engine the GSTR-1 export runs), the
//     outward-supply documents recorded for the month, and any amendment of an earlier month carried into this one.
//   • GSTR-3B Table 3.1(a)/(c) IS that figure — there is no input anywhere in this file that sets or adjusts an
//     outward figure. Before GSTR-1 is filed it is PROVISIONAL (it moves as sales bank); once GSTR-1 is filed the
//     figures are LOCKED (a stored fact, `Gstr3bLock`) and 3B reads the lock, never the live fold.
//   • The reconciliation lists every difference between 3B and the till by NAME — outward documents that did not come
//     from the till, amendments carried in, anything banked after GSTR-1 was filed (and whether an amendment has
//     carried it to the next month), a sold product that could not be put on the return — and anything left over is
//     `unexplained`. Nothing is absorbed into a total.
//   • Table 3.1(d) is the reverse-charge liability (A14) and is paid in CASH only; Table 4(A)(3) is the reverse-charge
//     ITC, which exists only once that liability is marked paid. Table 4 "all other ITC" reads the A17 port and is
//     "not yet reconciled" — an exception, never zero — until that lane answers.
//
// Pure and deterministic: no clock, no I/O, no hashing (the service hashes `gstr1CanonicalForm`).

import { salesToOutwardSupplies, netTable12, type SoldTaxLine, type ProductTaxEntry, type UnmappedReason } from './outward-from-sales';
import type { OutwardDocument } from './gstr1';
import type { ItcForPeriod } from './itc-port';
import { parseMonthlyPeriod, nextMonthlyPeriod } from './gst-period';

// ── money by tax head ────────────────────────────────────────────────────────────────────────────────────────────

/** Taxable value and tax by head, paise. */
export interface TaxHeads {
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
}

/** An outward figure: the taxable supplies (rate above 0) by head, and the nil-rated / exempt value (rate 0). */
export interface OutwardTotals {
  readonly heads: TaxHeads;
  readonly nilMinor: number;
}

export const ZERO_HEADS: TaxHeads = Object.freeze({ taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
export const ZERO_OUTWARD: OutwardTotals = Object.freeze({ heads: ZERO_HEADS, nilMinor: 0 });

export const taxOf = (h: TaxHeads): number => h.cgstMinor + h.sgstMinor + h.igstMinor;
export const addHeads = (a: TaxHeads, b: TaxHeads): TaxHeads => ({
  taxableMinor: a.taxableMinor + b.taxableMinor, cgstMinor: a.cgstMinor + b.cgstMinor, sgstMinor: a.sgstMinor + b.sgstMinor, igstMinor: a.igstMinor + b.igstMinor,
});
export const negHeads = (a: TaxHeads): TaxHeads => ({ taxableMinor: -a.taxableMinor, cgstMinor: -a.cgstMinor, sgstMinor: -a.sgstMinor, igstMinor: -a.igstMinor });
export const addOutward = (a: OutwardTotals, b: OutwardTotals): OutwardTotals => ({ heads: addHeads(a.heads, b.heads), nilMinor: a.nilMinor + b.nilMinor });
export const subOutward = (a: OutwardTotals, b: OutwardTotals): OutwardTotals => ({ heads: addHeads(a.heads, negHeads(b.heads)), nilMinor: a.nilMinor - b.nilMinor });
export const isZeroOutward = (a: OutwardTotals): boolean =>
  a.nilMinor === 0 && a.heads.taxableMinor === 0 && a.heads.cgstMinor === 0 && a.heads.sgstMinor === 0 && a.heads.igstMinor === 0;
/** Everything in an outward figure, taxable + tax + nil, paise — what the customer paid for it. */
export const grossOf = (a: OutwardTotals): number => a.heads.taxableMinor + taxOf(a.heads) + a.nilMinor;

// ── GSTR-1's figures for a month ─────────────────────────────────────────────────────────────────────────────────

/** An amendment of an earlier month carried into this one — a compensating event (A16). */
export interface CarriedAmendment {
  readonly amendmentId: string;
  /** The month whose filed figures it corrects. */
  readonly fromPeriod: string;
  /** The month it is declared in — always the month after `fromPeriod`. */
  readonly intoPeriod: string;
  /** The correction, signed: positive adds liability, negative reduces it. */
  readonly delta: OutwardTotals;
  readonly reason: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** GSTR-1 for one month, broken down by where each part came from. */
export interface Gstr1Figures {
  readonly period: string;
  /** Banked till sales less returns processed in the month. */
  readonly fromTill: OutwardTotals;
  /** Outward-supply documents recorded for the month (e.g. B2B invoices) — not from the till. */
  readonly documents: OutwardTotals;
  /** Amendments of earlier months declared in this one. */
  readonly amendmentsIn: OutwardTotals;
  /** fromTill + documents + amendmentsIn — what GSTR-1 declares. */
  readonly total: OutwardTotals;
}

/** A sold or returned product that could not be put on the return (no HSN/rate, bad HSN) — never dropped. */
export interface NotOnReturn {
  readonly side: 'sale' | 'return';
  readonly productId: string;
  readonly lineTotalMinor: number;
  readonly reason: UnmappedReason;
  readonly detail: string;
}

/** The till's own sum for the month: what was banked, less what was refunded, before any tax split. */
export interface SalesLedger {
  readonly grossSalesMinor: number;
  readonly grossReturnsMinor: number;
  /** grossSales − grossReturns, paise. */
  readonly netGrossMinor: number;
  readonly soldLineCount: number;
  readonly returnedLineCount: number;
  /** The same banked lines split into taxable value and tax (the products that could be placed on the return). */
  readonly split: OutwardTotals;
  /** The banked lines that could not be split (sales add, returns subtract). */
  readonly notOnReturn: readonly NotOnReturn[];
}

export interface Gstr1Computation {
  readonly figures: Gstr1Figures;
  readonly salesLedger: SalesLedger;
}

const sumLines = (lines: readonly SoldTaxLine[]): number => lines.reduce((s, l) => s + l.lineTotalMinor, 0);

function documentsTotal(docs: readonly OutwardDocument[]): OutwardTotals {
  let heads = ZERO_HEADS;
  let nil = 0;
  for (const d of docs) {
    for (const l of d.lines) {
      if (l.rateBps === 0) nil += l.taxableMinor;
      else heads = addHeads(heads, { taxableMinor: l.taxableMinor, cgstMinor: l.cgstMinor, sgstMinor: l.sgstMinor, igstMinor: l.igstMinor });
    }
  }
  return { heads, nilMinor: nil };
}

/**
 * Fold GSTR-1's figures for a month from what is stored, and the till's own sum beside it. `sold` are the banked sale
 * lines whose trading day is in the month; `returned` the returned lines processed in the month (each at the rate it
 * was sold); `documents` the outward-supply documents dated in the month; `amendmentsIn` the corrections of the
 * previous month declared in this one.
 */
export function computeGstr1Figures(input: {
  readonly period: string;
  readonly sold: readonly SoldTaxLine[];
  readonly returned: readonly SoldTaxLine[];
  readonly taxTable: readonly ProductTaxEntry[];
  readonly annualTurnoverMinor: number;
  readonly documents: readonly OutwardDocument[];
  readonly amendmentsIn: readonly CarriedAmendment[];
}): Gstr1Computation {
  parseMonthlyPeriod(input.period);
  const sales = salesToOutwardSupplies({ sales: input.sold, taxTable: input.taxTable, annualTurnoverMinor: input.annualTurnoverMinor });
  const returns = salesToOutwardSupplies({ sales: input.returned, taxTable: input.taxTable, annualTurnoverMinor: input.annualTurnoverMinor });
  const net = netTable12(sales.table12, returns.table12);
  let heads = ZERO_HEADS;
  let nil = 0;
  for (const r of net.rows) {
    if (r.rateBps === 0) nil += r.netTaxableMinor;
    else heads = addHeads(heads, { taxableMinor: r.netTaxableMinor, cgstMinor: r.netCgstMinor, sgstMinor: r.netSgstMinor, igstMinor: r.netIgstMinor });
  }
  const fromTill: OutwardTotals = { heads, nilMinor: nil };
  const documents = documentsTotal(input.documents);
  const amendmentsIn = input.amendmentsIn.reduce((acc, a) => addOutward(acc, a.delta), ZERO_OUTWARD);
  const notOnReturn: NotOnReturn[] = [
    ...sales.unmapped.map((u) => ({ side: 'sale' as const, productId: u.productId, lineTotalMinor: u.lineTotalMinor, reason: u.reason, detail: u.detail })),
    ...returns.unmapped.map((u) => ({ side: 'return' as const, productId: u.productId, lineTotalMinor: u.lineTotalMinor, reason: u.reason, detail: u.detail })),
  ];
  const grossSalesMinor = sumLines(input.sold);
  const grossReturnsMinor = sumLines(input.returned);
  return {
    figures: { period: input.period, fromTill, documents, amendmentsIn, total: addOutward(addOutward(fromTill, documents), amendmentsIn) },
    salesLedger: {
      grossSalesMinor, grossReturnsMinor, netGrossMinor: grossSalesMinor - grossReturnsMinor,
      soldLineCount: input.sold.length, returnedLineCount: input.returned.length,
      split: fromTill, notOnReturn,
    },
  };
}

/**
 * A stable text form of GSTR-1's figures — the service hashes it into the digest a GSTR-1 preview records, and the
 * A16 lock compares the filed digest against it. Fixed key order; integers only.
 */
export function gstr1CanonicalForm(f: Gstr1Figures): string {
  const o = (t: OutwardTotals): readonly number[] => [t.heads.taxableMinor, t.heads.cgstMinor, t.heads.sgstMinor, t.heads.igstMinor, t.nilMinor];
  return JSON.stringify({ v: 1, period: f.period, fromTill: o(f.fromTill), documents: o(f.documents), amendmentsIn: o(f.amendmentsIn), total: o(f.total) });
}

// ── the A16 lock ─────────────────────────────────────────────────────────────────────────────────────────────────

/** GSTR-1's figures frozen at the moment the 3B outward liability was locked to the filed GSTR-1. A stored fact. */
export interface Gstr3bLock {
  readonly period: string;
  readonly figures: Gstr1Figures;
  /** The portal reference of the filed GSTR-1. */
  readonly arn: string;
  readonly lockedBy: string;
  readonly lockedAt: string;
  /** The digest the GSTR-1 submission recorded when it was approved and filed. */
  readonly filedDigest: string;
  /** The digest of `figures`. */
  readonly computedDigest: string;
}

export type Gstr1FilingState = 'not_started' | 'previewed' | 'approved' | 'submitting' | 'filed' | 'failed' | 'unknown' | 'cancelled';

export type LockRefusal = 'gstr1_not_filed' | 'already_locked';

/**
 * May the 3B outward liability be locked now? Only once GSTR-1 for the period is `filed`, and only once (a lock is
 * never replaced — a correction is an amendment in the next month).
 */
export function evaluateGstr3bLock(input: { readonly gstr1State: Gstr1FilingState; readonly existing?: Gstr3bLock }):
  { readonly allowed: true } | { readonly allowed: false; readonly refusal: LockRefusal; readonly reason: string } {
  if (input.existing !== undefined) {
    return { allowed: false, refusal: 'already_locked', reason: `the GSTR-3B outward liability for ${input.existing.period} is already locked to the filed GSTR-1 (${input.existing.arn}); a lock is never replaced — correct it by an amendment in the next month` };
  }
  if (input.gstr1State !== 'filed') {
    return { allowed: false, refusal: 'gstr1_not_filed', reason: `GSTR-1 for this month is ${input.gstr1State === 'not_started' ? 'not started' : input.gstr1State}, not filed — the GSTR-3B outward liability can only be locked to a FILED GSTR-1` };
  }
  return { allowed: true };
}

/**
 * The answer to ANY request to change the 3B outward liability. There is no path that accepts one: before GSTR-1 is
 * filed the figure is derived from the stored sales, returns and documents (correct those); after, it is locked to
 * the filed GSTR-1 (correct it by an amendment in the next month). Total and pure — the guardrail binds to it.
 */
export function refuseOutwardChange(input: { readonly period: string; readonly lock?: Gstr3bLock }):
  { readonly allowed: false; readonly refusal: 'locked_to_filed_gstr1' | 'derived_from_stored_sales'; readonly reason: string; readonly nextSafeAction: string } {
  if (input.lock !== undefined) {
    return {
      allowed: false, refusal: 'locked_to_filed_gstr1',
      reason: `the GSTR-3B outward liability for ${input.period} is locked to the filed GSTR-1 (${input.lock.arn}) and cannot be changed`,
      nextSafeAction: `Record an amendment of ${input.period}; it is declared in ${nextMonthlyPeriod(input.period)}'s GSTR-1 as a compensating entry.`,
    };
  }
  return {
    allowed: false, refusal: 'derived_from_stored_sales',
    reason: `the GSTR-3B outward liability for ${input.period} is worked out from the banked sales, returns and outward documents — it is never typed in`,
    nextSafeAction: 'Correct the sale, return or document itself; the return follows it.',
  };
}

// ── the amendment (compensating event) ───────────────────────────────────────────────────────────────────────────

export type AmendmentRefusal = 'not_locked' | 'nothing_to_amend' | 'next_month_already_locked';

/**
 * What an amendment of a locked month would carry: what is stored for the month now, less what was filed, less what
 * earlier amendments already carried. Refused when the month is not locked (correct the data instead), when nothing is
 * left to carry, or when the next month's GSTR-1 is already filed (its liability is locked too).
 */
export function evaluateAmendment(input: {
  readonly lock: Gstr3bLock | undefined;
  readonly current: Gstr1Figures;
  readonly alreadyCarried: readonly CarriedAmendment[];
  readonly nextMonthLocked: boolean;
}): { readonly allowed: true; readonly delta: OutwardTotals; readonly intoPeriod: string } | { readonly allowed: false; readonly refusal: AmendmentRefusal; readonly reason: string } {
  if (input.lock === undefined) {
    return { allowed: false, refusal: 'not_locked', reason: `GSTR-1 for ${input.current.period} is not filed and locked — correct the stored sales, returns or documents instead; an amendment corrects a FILED month` };
  }
  const delta = unamendedChange(input.lock, input.current, input.alreadyCarried);
  if (isZeroOutward(delta)) {
    return { allowed: false, refusal: 'nothing_to_amend', reason: `nothing has changed for ${input.lock.period} since GSTR-1 was filed that an amendment has not already carried` };
  }
  const intoPeriod = nextMonthlyPeriod(input.lock.period);
  if (input.nextMonthLocked) {
    return { allowed: false, refusal: 'next_month_already_locked', reason: `the amendment is declared in ${intoPeriod}'s GSTR-1, which is already filed and locked` };
  }
  return { allowed: true, delta, intoPeriod };
}

/** Banked/recorded since GSTR-1 was filed (till + documents), less what amendments already carried. */
function unamendedChange(lock: Gstr3bLock, current: Gstr1Figures, carried: readonly CarriedAmendment[]): OutwardTotals {
  const changed = subOutward(addOutward(current.fromTill, current.documents), addOutward(lock.figures.fromTill, lock.figures.documents));
  return subOutward(changed, carried.reduce((acc, a) => addOutward(acc, a.delta), ZERO_OUTWARD));
}

// ── the return and its reconciliation ────────────────────────────────────────────────────────────────────────────

export type Gstr3bBasis = 'locked_to_filed_gstr1' | 'provisional_gstr1_not_filed' | 'gstr1_filed_not_yet_locked';

export type DifferenceCode =
  | 'documents_not_from_till'            // explained: GSTR-1 carries outward documents the till did not bank
  | 'amendment_from_earlier_period'      // explained: a correction of last month declared in this one
  | 'changed_after_gstr1_filed'          // EXCEPTION: banked/recorded after GSTR-1 was filed, not yet amended
  | 'carried_by_amendment'               // explained: the part of a post-filing change an amendment carried forward
  | 'sold_not_on_return'                 // EXCEPTION: a banked product that could not be put on the return
  | 'unexplained';                       // EXCEPTION: anything left over

export interface Gstr3bDifference {
  readonly code: DifferenceCode;
  /** True when the difference is accounted for by a named, recorded cause; false = an exception for a person. */
  readonly explained: boolean;
  /** Signed: 3B minus the till (or, for `changed_after_gstr1_filed`, stored now minus filed). */
  readonly amount: OutwardTotals;
  /** Gross (taxable + tax + nil), for one-line display. */
  readonly grossMinor: number;
  readonly detail: string;
  readonly productId?: string;
  readonly amendmentId?: string;
}

export type Gstr3bExceptionCode =
  | 'gstr1_not_filed' | 'gstr1_filed_not_yet_locked' | 'filed_digest_does_not_match'
  | 'itc_not_yet_reconciled' | 'reconciliation_difference';

export interface Gstr3bException {
  readonly code: Gstr3bExceptionCode;
  readonly detail: string;
}

export interface NotProduced {
  readonly status: 'not_produced';
  readonly detail: string;
}

export interface Gstr3b {
  readonly period: string;
  readonly basis: Gstr3bBasis;
  /** Always false: no path edits the outward liability (A16). */
  readonly editable: false;
  readonly table31: {
    /** (a) outward taxable supplies (other than zero-rated, nil-rated and exempted). */
    readonly a: TaxHeads;
    /** (b) zero-rated supplies (exports, SEZ) — the shop makes none through this system. */
    readonly b: NotProduced;
    /** (c) nil-rated and exempted supplies — taxable value only. */
    readonly c: { readonly taxableMinor: number };
    /** (d) inward supplies liable to reverse charge (A14) — paid in cash. */
    readonly d: TaxHeads;
    /** (e) non-GST outward supplies — not recorded by this system. */
    readonly e: NotProduced;
  };
  readonly table4: {
    /** 4(A)(3) ITC on inward supplies liable to reverse charge — only what has been PAID. */
    readonly a3ReverseCharge: TaxHeads;
    /** 4(A)(5) all other ITC — from the GSTR-2B / IMS reconciliation (A17). "Not yet reconciled" is not zero. */
    readonly a5AllOther: ItcForPeriod;
  };
  readonly table61: {
    /** Output tax on outward supplies (3.1 a). Its set-off against ITC is done on the portal by the accountant. */
    readonly outwardTaxMinor: number;
    readonly outwardSetOff: NotProduced;
    /** Reverse-charge tax (3.1 d). Paid in cash only — never set off against ITC. */
    readonly reverseChargeTaxMinor: number;
    readonly reverseChargePaidInCashMinor: number;
    readonly reverseChargeSetOffAgainstItcMinor: 0;
  };
  readonly gstr1: Gstr1Figures;
  readonly lock?: Gstr3bLock;
  readonly reconciliation: {
    readonly salesLedger: SalesLedger;
    /** 3.1(a) + 3.1(c) as one outward figure. */
    readonly table31Outward: OutwardTotals;
    /** 3.1 equals GSTR-1's total (always, by construction — said, so a reader need not take it on trust). */
    readonly equalsGstr1: boolean;
    /** 3.1 equals the till's split with no difference at all. */
    readonly equalsSalesLedger: boolean;
    readonly differences: readonly Gstr3bDifference[];
  };
  readonly exceptions: readonly Gstr3bException[];
  readonly detail: string;
}

const difference = (code: DifferenceCode, explained: boolean, amount: OutwardTotals, detail: string, extra: { productId?: string; amendmentId?: string } = {}): Gstr3bDifference => ({
  code, explained, amount, grossMinor: grossOf(amount), detail, ...extra,
});

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/**
 * Build GSTR-3B for a month and reconcile it to the till.
 *
 * `current` is GSTR-1 folded from what is stored NOW; `lock` the figures frozen when GSTR-1 was filed (absent until
 * then); `amendmentsOut` the amendments of THIS month declared in the next; `reverseCharge` the month's RCM liability
 * (3.1 d) and the RCM ITC whose liability was paid in the month (4 A 3); `itc` the A17 port's answer.
 */
export function buildGstr3b(input: {
  readonly period: string;
  readonly current: Gstr1Computation;
  readonly gstr1State: Gstr1FilingState;
  readonly lock?: Gstr3bLock;
  /** Amendments of the previous month declared in this one (their total is already inside `current` / `lock`). */
  readonly amendmentsIn: readonly CarriedAmendment[];
  readonly amendmentsOut: readonly CarriedAmendment[];
  readonly reverseCharge: { readonly liability: TaxHeads; readonly itcPaid: TaxHeads };
  readonly itc: ItcForPeriod;
}): Gstr3b {
  parseMonthlyPeriod(input.period);
  const lock = input.lock;
  const filed = lock !== undefined ? lock.figures : input.current.figures;
  const basis: Gstr3bBasis = lock !== undefined ? 'locked_to_filed_gstr1'
    : input.gstr1State === 'filed' ? 'gstr1_filed_not_yet_locked' : 'provisional_gstr1_not_filed';

  const table31Outward = filed.total;
  const ledger = input.current.salesLedger;
  const differences: Gstr3bDifference[] = [];

  if (!isZeroOutward(filed.documents)) {
    differences.push(difference('documents_not_from_till', true, filed.documents, `GSTR-1 includes outward-supply documents recorded for the month that the till did not bank (${rupees(grossOf(filed.documents))})`));
  }
  for (const a of input.amendmentsIn) {
    differences.push(difference('amendment_from_earlier_period', true, a.delta, `amendment ${a.amendmentId} of ${a.fromPeriod} declared in this month: ${a.reason}`, { amendmentId: a.amendmentId }));
  }
  if (lock !== undefined) {
    // What is stored now for the month versus what was filed (till + documents). A part an amendment has carried to the
    // next month is explained; the rest is an exception until it is amended.
    const changedAll = subOutward(addOutward(input.current.figures.fromTill, input.current.figures.documents), addOutward(lock.figures.fromTill, lock.figures.documents));
    const carried = input.amendmentsOut.reduce((acc, a) => addOutward(acc, a.delta), ZERO_OUTWARD);
    for (const a of input.amendmentsOut) {
      differences.push(difference('carried_by_amendment', true, a.delta, `changed after GSTR-1 was filed and carried to ${a.intoPeriod} by amendment ${a.amendmentId}: ${a.reason}`, { amendmentId: a.amendmentId }));
    }
    const unamended = subOutward(changedAll, carried);
    if (!isZeroOutward(unamended)) {
      differences.push(difference('changed_after_gstr1_filed', false, unamended, `${rupees(grossOf(unamended))} was banked or recorded for this month after GSTR-1 was filed (${lock.arn}) — the filed figure stands; record an amendment so it is declared in ${nextMonthlyPeriod(input.period)}`));
    }
  }
  for (const n of ledger.notOnReturn) {
    // The tax split is unknown (that is the problem), so the difference carries the line's gross, signed.
    differences.push({
      code: 'sold_not_on_return', explained: false, amount: ZERO_OUTWARD,
      grossMinor: n.side === 'sale' ? n.lineTotalMinor : -n.lineTotalMinor, productId: n.productId,
      detail: `${n.side === 'sale' ? 'sold' : 'returned'} ${n.productId} (${rupees(n.lineTotalMinor)}) is NOT on the return: ${n.detail}`,
    });
  }

  // The residual: 3B − till split − documents − amendments in − (filed till − current till). Zero unless a cause is
  // missing above; anything left is an exception, never absorbed.
  const explainedAgainstTill = addOutward(addOutward(filed.documents, filed.amendmentsIn), subOutward(filed.fromTill, input.current.figures.fromTill));
  const residual = subOutward(subOutward(table31Outward, ledger.split), explainedAgainstTill);
  if (!isZeroOutward(residual)) {
    differences.push(difference('unexplained', false, residual, `GSTR-3B and the till differ by ${rupees(grossOf(residual))} with no recorded cause — a person must find it`));
  }
  // The gross check: the till's own sum, less what could not be placed on the return, must equal its split to the paisa.
  const notOnReturnNet = ledger.notOnReturn.reduce((s, n) => s + (n.side === 'sale' ? n.lineTotalMinor : -n.lineTotalMinor), 0);
  const grossGap = ledger.netGrossMinor - notOnReturnNet - grossOf(ledger.split);
  if (grossGap !== 0) {
    differences.push({ code: 'unexplained', explained: false, amount: ZERO_OUTWARD, grossMinor: grossGap, detail: `the till banked ${rupees(ledger.netGrossMinor)} net but its tax split adds to ${rupees(grossOf(ledger.split) + notOnReturnNet)} — ${rupees(grossGap)} unexplained` });
  }

  const exceptions: Gstr3bException[] = [];
  if (basis === 'provisional_gstr1_not_filed') exceptions.push({ code: 'gstr1_not_filed', detail: `GSTR-1 for ${input.period} is not filed — these GSTR-3B outward figures are provisional and will move as sales bank` });
  if (basis === 'gstr1_filed_not_yet_locked') exceptions.push({ code: 'gstr1_filed_not_yet_locked', detail: `GSTR-1 for ${input.period} is filed but GSTR-3B has not been locked to it yet — prepare GSTR-3B to lock it` });
  if (lock !== undefined && lock.filedDigest !== lock.computedDigest) {
    exceptions.push({ code: 'filed_digest_does_not_match', detail: `the figures locked for ${input.period} do not match the digest the GSTR-1 submission recorded — check the filed GSTR-1 on the portal against these figures` });
  }
  if (input.itc.status === 'not_reconciled') exceptions.push({ code: 'itc_not_yet_reconciled', detail: input.itc.detail });
  const open = differences.filter((d) => !d.explained);
  if (open.length > 0) exceptions.push({ code: 'reconciliation_difference', detail: `${open.length} difference(s) between GSTR-3B and the till need a person` });

  const rc = input.reverseCharge.liability;
  return {
    period: input.period,
    basis,
    editable: false,
    table31: {
      a: table31Outward.heads,
      b: { status: 'not_produced', detail: 'zero-rated supplies (exports, SEZ) — the shop makes none through this system' },
      c: { taxableMinor: table31Outward.nilMinor },
      d: rc,
      e: { status: 'not_produced', detail: 'non-GST outward supplies are not recorded by this system' },
    },
    table4: { a3ReverseCharge: input.reverseCharge.itcPaid, a5AllOther: input.itc },
    table61: {
      outwardTaxMinor: taxOf(table31Outward.heads),
      outwardSetOff: { status: 'not_produced', detail: 'the set-off of input credit against output tax is made on the portal by the accountant' },
      reverseChargeTaxMinor: taxOf(rc),
      reverseChargePaidInCashMinor: taxOf(rc),
      reverseChargeSetOffAgainstItcMinor: 0,
    },
    gstr1: filed,
    ...(lock !== undefined ? { lock } : {}),
    reconciliation: {
      salesLedger: ledger,
      table31Outward,
      equalsGstr1: grossOf(subOutward(table31Outward, filed.total)) === 0 && isZeroOutward(subOutward(table31Outward, filed.total)),
      equalsSalesLedger: differences.length === 0,
      differences,
    },
    exceptions,
    detail: `${input.period}: 3.1(a) taxable ${rupees(table31Outward.heads.taxableMinor)}, tax ${rupees(taxOf(table31Outward.heads))}; ${basis.replace(/_/g, ' ')}; ${open.length} open difference(s), ${exceptions.length} exception(s)`,
  };
}
