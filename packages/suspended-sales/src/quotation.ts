// Quotations (M12-FR-02 / M22 B2B) — a price promised, not a sale made.
//
// A quotation is the one document in the shop that **looks like a sale and must not
// behave like one**. Every failure here is the same failure wearing a different hat:
// treating the promise as the transaction.
//
//   • **IT MOVES NO STOCK.** Quoting 200 kg of rice must not reserve 200 kg of rice.
//     Quote three customers for the same pallet and a reserving system takes the shop
//     out of stock on paper while the pallet sits there. Nothing in this module
//     touches the ledger, and the acceptance test asserts exactly that.
//
//   • **THE PRICE IS HELD, AND ONLY FOR AS LONG AS IT WAS PROMISED.** A customer shown
//     ₹4,200.00 and charged ₹4,600.00 at the counter is the complaint this prevents.
//     But quietly honouring a quotation from six weeks ago is the opposite leak, and
//     it is invisible until the margin report. So the quoted price is honoured **inside
//     the validity window and refused outside it** — never silently re-priced either way.
//
//   • **YOU CANNOT QUOTE YOUR WAY PAST A CONTROL.** A quotation below the margin floor
//     needs the same separate approval a discount needs (M05-FR-02, §28). Otherwise
//     the quotation becomes the route around the price guard, which is precisely the
//     route people find.
//
//   • **CONVERTING IS IDEMPOTENT.** A quotation converts to exactly one sale. A second
//     attempt returns the sale that already exists rather than making another.
//
// A withdrawn or expired quotation is **kept** (hard rule #6): an unconverted quotation
// is a lost sale, and the pattern of who quotes and never closes is worth seeing.
//
// Pure and deterministic: no clock, no I/O, no stock.

export interface QuotationLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  /** The price promised, in integer minor units (§29.1). */
  readonly unitPriceMinor: number;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly taxBps: number;
  /** Unit cost at quote time, so the margin can be checked before the promise is made. */
  readonly unitCostMinor?: number;
}

export type QuotationState = 'issued' | 'converted' | 'expired' | 'withdrawn';

export interface Quotation {
  readonly quotationId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly customerRef: string;
  readonly currency: string;
  readonly lines: readonly QuotationLine[];
  readonly issuedBy: string;
  readonly issuedAt: string;
  /** Inclusive last date the quoted price stands, as YYYY-MM-DD. */
  readonly validUntil: string;
  readonly state: QuotationState;
  readonly totalMinor: number;
  readonly convertedSaleId?: string;
  readonly convertedAt?: string;
  readonly withdrawnAt?: string;
  readonly withdrawnBy?: string;
  readonly withdrawReason?: string;
  /** The approval that authorised a below-floor price, where one was needed. */
  readonly marginApprovedBy?: string;
}

/** The approval shape a below-floor quotation needs (mirrors `packages/approvals`). */
export interface QuotationApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
  readonly reason: string;
}

export type IssueRefusal =
  | 'issued'
  | 'no_lines'
  | 'invalid_validity'
  | 'below_floor_unapproved'
  | 'self_approved';

export interface IssueResult {
  readonly quotationId: string;
  readonly issued: boolean;
  readonly outcome: IssueRefusal;
  readonly detail: string;
  readonly quotation?: Quotation;
}

/** Line total before tax, in minor units. Integer arithmetic throughout. */
export function lineValueMinor(line: QuotationLine): number {
  return line.unitPriceMinor * line.quantityMinor;
}

function totalOf(lines: readonly QuotationLine[]): number {
  return lines.reduce((sum, l) => sum + lineValueMinor(l), 0);
}

/**
 * Issue a quotation. Nothing is reserved, nothing is committed, and no stock moves —
 * a quotation is a promise about price, and the shop keeps selling the goods.
 */
export function issueQuotation(
  input: {
    readonly quotationId: string;
    readonly tenantId: string;
    readonly storeId: string;
    readonly customerRef: string;
    readonly currency: string;
    readonly lines: readonly QuotationLine[];
    readonly issuedBy: string;
    readonly issuedAt: string;
    readonly validUntil: string;
    /** Minimum margin in basis points the tenant requires (M05-FR-02). */
    readonly marginFloorBps?: number;
    readonly approval?: QuotationApproval;
  },
): IssueResult {
  const base = { quotationId: input.quotationId };

  if (input.lines.length === 0) {
    return { ...base, issued: false, outcome: 'no_lines', detail: 'a quotation for nothing is not a quotation' };
  }
  if (input.validUntil < input.issuedAt.slice(0, 10)) {
    return {
      ...base,
      issued: false,
      outcome: 'invalid_validity',
      detail: `a quotation cannot expire on ${input.validUntil}, before the day it was issued`,
    };
  }

  // The margin check runs on the whole quotation, because a salesperson can hide a
  // loss-making line inside a healthy one and the customer only ever sees the total.
  if (input.marginFloorBps !== undefined) {
    const priced = input.lines.filter((l) => l.unitCostMinor !== undefined);
    const revenue = priced.reduce((s, l) => s + lineValueMinor(l), 0);
    const cost = priced.reduce((s, l) => s + (l.unitCostMinor ?? 0) * l.quantityMinor, 0);
    if (revenue > 0) {
      // Exact basis points, no floating point (§29.1).
      const marginBps = Number(((BigInt(revenue - cost) * 10_000n) / BigInt(revenue)));
      if (marginBps < input.marginFloorBps) {
        const a = input.approval;
        if (a === undefined || a.status !== 'approved' || a.subjectRef !== input.quotationId) {
          return {
            ...base,
            issued: false,
            outcome: 'below_floor_unapproved',
            detail: `this quotation makes ${(marginBps / 100).toFixed(2)}% against a floor of ${(input.marginFloorBps / 100).toFixed(2)}% — it needs an approval before the price is promised`,
          };
        }
        if (a.decidedBy === input.issuedBy) {
          return {
            ...base,
            issued: false,
            outcome: 'self_approved',
            detail: 'the person quoting cannot approve their own below-floor price (§28)',
          };
        }
      }
    }
  }

  const quotation: Quotation = {
    quotationId: input.quotationId,
    tenantId: input.tenantId,
    storeId: input.storeId,
    customerRef: input.customerRef,
    currency: input.currency,
    lines: input.lines,
    issuedBy: input.issuedBy,
    issuedAt: input.issuedAt,
    validUntil: input.validUntil,
    state: 'issued',
    totalMinor: totalOf(input.lines),
    ...(input.approval?.status === 'approved' ? { marginApprovedBy: input.approval.decidedBy } : {}),
  };

  return {
    ...base,
    issued: true,
    outcome: 'issued',
    quotation,
    detail: `quoted ${input.lines.length} line(s) to ${input.customerRef}, held until ${input.validUntil}`,
  };
}

export type ConvertRefusal =
  | 'converted'
  | 'already_converted'
  | 'expired'
  | 'withdrawn'
  | 'quantity_exceeds_quote';

export interface ConvertResult {
  readonly quotationId: string;
  readonly converted: boolean;
  readonly outcome: ConvertRefusal;
  readonly detail: string;
  readonly quotation: Quotation;
  /** The sale lines to ring up, at the prices that were promised. */
  readonly saleLines?: readonly QuotationLine[];
  readonly saleId?: string;
}

/**
 * Convert a quotation into a sale. The **quoted** prices are used — that is what the
 * customer was promised — but only while the quotation is still valid. An expired
 * quotation is refused rather than honoured or silently re-priced, because both of
 * those decisions belong to a person.
 *
 * Idempotent: converting twice returns the sale that already exists.
 */
export function convertQuotation(
  input: {
    readonly quotation: Quotation;
    readonly saleId: string;
    readonly at: string;
    /** Optional partial conversion — the customer takes fewer than they were quoted. */
    readonly quantities?: Readonly<Record<string, number>>;
  },
): ConvertResult {
  const q = input.quotation;
  const base = { quotationId: q.quotationId, quotation: q };

  if (q.state === 'converted') {
    return {
      ...base,
      converted: false,
      outcome: 'already_converted',
      saleId: q.convertedSaleId,
      detail: `already converted to sale ${q.convertedSaleId ?? 'unknown'} — a quotation becomes one sale, not two`,
    };
  }
  if (q.state === 'withdrawn') {
    return {
      ...base,
      converted: false,
      outcome: 'withdrawn',
      detail: `withdrawn${q.withdrawReason === undefined ? '' : ` (${q.withdrawReason})`}`,
    };
  }
  if (input.at.slice(0, 10) > q.validUntil) {
    return {
      ...base,
      converted: false,
      outcome: 'expired',
      quotation: { ...q, state: 'expired' },
      detail: `the quoted price was held until ${q.validUntil} and that date has passed — re-quote rather than honouring or changing it quietly`,
    };
  }

  let saleLines = q.lines;
  if (input.quantities !== undefined) {
    const taken = input.quantities;
    for (const line of q.lines) {
      const want = taken[line.lineId];
      if (want !== undefined && want > line.quantityMinor) {
        // A quoted price bought a quoted quantity. More than that is a new negotiation.
        return {
          ...base,
          converted: false,
          outcome: 'quantity_exceeds_quote',
          detail: `${line.description}: ${want} requested against ${line.quantityMinor} quoted — the held price covers the quoted quantity only`,
        };
      }
    }
    saleLines = q.lines
      .map((line) => ({ ...line, quantityMinor: taken[line.lineId] ?? line.quantityMinor }))
      .filter((line) => line.quantityMinor > 0);
  }

  const converted: Quotation = {
    ...q,
    state: 'converted',
    convertedSaleId: input.saleId,
    convertedAt: input.at,
  };
  return {
    quotationId: q.quotationId,
    converted: true,
    outcome: 'converted',
    quotation: converted,
    saleLines,
    saleId: input.saleId,
    detail: `converted to sale ${input.saleId} at the quoted prices`,
  };
}

/** Withdraw a quotation with a reason. The record is kept, never deleted (hard rule #6). */
export function withdrawQuotation(input: {
  readonly quotation: Quotation;
  readonly byUserId: string;
  readonly reason: string;
  readonly at: string;
}): { readonly withdrawn: boolean; readonly detail: string; readonly quotation: Quotation } {
  const q = input.quotation;
  if (q.state !== 'issued') {
    return { withdrawn: false, detail: `this quotation is ${q.state}`, quotation: q };
  }
  if (input.reason.trim() === '') {
    return { withdrawn: false, detail: 'withdrawing a quotation needs a reason', quotation: q };
  }
  return {
    withdrawn: true,
    detail: `withdrawn by ${input.byUserId}: ${input.reason}`,
    quotation: {
      ...q,
      state: 'withdrawn',
      withdrawnAt: input.at,
      withdrawnBy: input.byUserId,
      withdrawReason: input.reason,
    },
  };
}

export interface QuotationFollowUp {
  readonly quotationId: string;
  readonly customerRef: string;
  readonly valueMinor: number;
  readonly daysLeft: number;
  readonly detail: string;
}

/**
 * The follow-up list. An issued quotation nobody chased is a sale the shop already did
 * the work for and then lost, so expiring ones are surfaced **before** they lapse —
 * soonest first — and lapsed ones are reported rather than dropped.
 */
export function quotationsNeedingFollowUp(
  quotations: readonly Quotation[],
  today: string,
  withinDays = 3,
): readonly QuotationFollowUp[] {
  const dayMs = 86_400_000;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return quotations
    .filter((q) => q.state === 'issued')
    .map((q) => ({
      q,
      daysLeft: Math.round((Date.parse(`${q.validUntil}T00:00:00Z`) - todayMs) / dayMs),
    }))
    .filter(({ daysLeft }) => daysLeft <= withinDays)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .map(({ q, daysLeft }) => ({
      quotationId: q.quotationId,
      customerRef: q.customerRef,
      valueMinor: q.totalMinor,
      daysLeft,
      detail:
        daysLeft < 0
          ? `lapsed ${-daysLeft} day(s) ago without an answer — the work was done and the sale was lost`
          : daysLeft === 0
            ? 'expires today'
            : `expires in ${daysLeft} day(s)`,
    }));
}
