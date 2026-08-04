// Credit notes, debit notes and returns reporting (M23-FR-02 remainder / §29.1 / hard rule #2).
//
// A credit note is the document that undoes a tax invoice, and Indian GST is specific about
// how: **you do not edit the invoice.** Section 34 of the CGST Act gives you a credit note,
// with its own number, its own date, and a reference to the invoice it relieves — and it must
// be declared in the return for the month it was issued, not the month the invoice was.
//
// That is the same shape as hard rule #2, arrived at independently by the tax code: **a
// correction is a compensating document, never an overwrite.** Which is convenient, because
// the commonest small-business accounting error is exactly the forbidden one — reissuing the
// invoice with a lower figure — and it produces a return that does not match the buyer's, an
// input-credit mismatch on their side, and a notice on yours.
//
//   • **A CREDIT NOTE NEVER EXCEEDS WHAT THE INVOICE CHARGED**, cumulatively across every
//     note against it. Crediting more than you billed is not a discount, it is a payment out
//     dressed as an adjustment.
//   • **TAX IS REVERSED IN THE SAME PROPORTION IT WAS CHARGED.** Reversing the goods and
//     keeping the GST is a real error that survives audits precisely because the totals still
//     add up on the face of the document.
//   • **THE TIME LIMIT IS REAL.** Under section 34(2) a credit note affecting output tax must
//     be declared by **30 November following the financial year** of the invoice (or the
//     annual return, whichever is earlier). After that a credit note can still be issued
//     commercially — the tax simply cannot be reclaimed, and saying so plainly is the
//     difference between a decision and a surprise.
//   • **A RETURNS REPORT SEPARATES THE REASONS.** "₹80,000 of returns" is a number nobody can
//     act on. Damaged-on-arrival is a supplier conversation, changed-mind is a returns policy,
//     and wrong-item-picked is a training one.
//
// Exact integer money throughout. Pure and deterministic: the clock is injected, no I/O.

export type NoteKind = 'credit_note' | 'debit_note';

export type CreditReason =
  | 'goods_returned'
  | 'deficiency_in_service'
  | 'post_supply_discount'
  | 'price_correction'
  | 'tax_rate_correction'
  | 'order_cancelled';

export interface TaxComponent {
  /** e.g. "CGST", "SGST", "IGST", "CESS". */
  readonly component: string;
  readonly rateBps: number;
  readonly amountMinor: number;
}

export interface SourceInvoice {
  readonly invoiceId: string;
  readonly number: string;
  readonly customerId: string;
  readonly issuedOn: string;
  readonly taxableMinor: number;
  readonly taxes: readonly TaxComponent[];
  readonly grossMinor: number;
  /** The financial year it falls in, e.g. "2026-27". Drives the section 34(2) limit. */
  readonly financialYear: string;
}

export type NoteOutcome =
  | 'issued'
  | 'exceeds_invoice'
  | 'wrong_customer'
  | 'no_reason'
  | 'zero_value'
  | 'tax_not_proportionate'
  | 'invoice_not_found';

export interface CreditNote {
  readonly noteId: string;
  readonly number: string;
  readonly kind: NoteKind;
  readonly againstInvoiceId: string;
  readonly againstInvoiceNumber: string;
  readonly customerId: string;
  readonly issuedOn: string;
  readonly reason: CreditReason;
  readonly taxableMinor: number;
  readonly taxes: readonly TaxComponent[];
  readonly grossMinor: number;
  /** False when the window in section 34(2) has passed — commercial only, no tax relief. */
  readonly taxAdjustable: boolean;
  /** The return period it belongs to: when it was ISSUED, not when the invoice was. */
  readonly declareInPeriod: string;
  readonly detail: string;
}

export interface NoteResult {
  readonly issued: boolean;
  readonly outcome: NoteOutcome;
  readonly note?: CreditNote;
  readonly detail: string;
}

/**
 * The last date a credit note against this financial year can still adjust output tax:
 * **30 November following the year end** (CGST s.34(2)).
 *
 * A financial year written "2026-27" ends 31 March 2027, so the limit is 30 November 2027.
 */
export function taxAdjustmentDeadline(financialYear: string): string {
  const start = Number(financialYear.slice(0, 4));
  return `${start + 1}-11-30`;
}

/**
 * Issue a credit or debit note against an invoice.
 *
 * **The invoice is never edited** (hard rule #2, and independently CGST s.34). Reissuing it at
 * a lower figure is the commonest small-business accounting error there is, and it produces a
 * return that does not match the buyer's — an input-credit mismatch on their side and a notice
 * on yours.
 *
 * Tax must be reversed **in the proportion it was charged**. Reversing the goods and keeping
 * the GST is an error that survives audits precisely because the document's own totals still
 * add up; the check here is against the *original invoice's* ratio, which is the only place
 * the truth lives.
 */
export function issueCreditNote(input: {
  readonly noteId: string;
  readonly number: string;
  readonly kind: NoteKind;
  readonly invoice: SourceInvoice;
  readonly customerId: string;
  readonly reason: CreditReason;
  /** Taxable value being credited (positive). */
  readonly taxableMinor: number;
  readonly taxes: readonly TaxComponent[];
  /** Taxable value already credited against this invoice by earlier notes. */
  readonly alreadyCreditedMinor?: number;
  readonly issuedOn: string;
  /** Rounding slack when checking tax proportion, in minor units. Default 1 (a paisa). */
  readonly taxToleranceMinor?: number;
}): NoteResult {
  const inv = input.invoice;
  const refuse = (outcome: NoteOutcome, detail: string): NoteResult => ({ issued: false, outcome, detail });

  if (inv.customerId !== input.customerId) {
    return refuse('wrong_customer', `${inv.number} was issued to a different customer`);
  }
  if (input.taxableMinor <= 0) {
    return refuse('zero_value', 'a credit note for nothing is not a credit note');
  }

  const cumulative = (input.alreadyCreditedMinor ?? 0) + input.taxableMinor;
  if (input.kind === 'credit_note' && cumulative > inv.taxableMinor) {
    return refuse(
      'exceeds_invoice',
      `${cumulative} credited against an invoice of ${inv.taxableMinor} — crediting more than you billed is not a discount, it is a payment out dressed as an adjustment`,
    );
  }

  // Tax must come off in the proportion it went on. BigInt so a large invoice cannot drift.
  const tolerance = input.taxToleranceMinor ?? 1;
  for (const charged of inv.taxes) {
    const reversing = input.taxes.find((t) => t.component === charged.component);
    const expected =
      inv.taxableMinor === 0
        ? 0
        : Number((BigInt(charged.amountMinor) * BigInt(input.taxableMinor)) / BigInt(inv.taxableMinor));
    const actual = reversing?.amountMinor ?? 0;
    if (Math.abs(actual - expected) > tolerance) {
      return refuse(
        'tax_not_proportionate',
        `${charged.component}: reversing ${actual} where ${expected} was charged on this share of the invoice — reversing the goods and keeping the tax is an error that survives audits because the document's own totals still add up`,
      );
    }
  }
  const unknown = input.taxes.filter((t) => !inv.taxes.some((c) => c.component === t.component));
  if (unknown.length > 0) {
    return refuse(
      'tax_not_proportionate',
      `${unknown.map((t) => t.component).join(', ')} was never charged on ${inv.number} and cannot be reversed`,
    );
  }

  const deadline = taxAdjustmentDeadline(inv.financialYear);
  const taxAdjustable = input.issuedOn <= deadline;
  const taxMinor = input.taxes.reduce((s, t) => s + t.amountMinor, 0);

  return {
    issued: true,
    outcome: 'issued',
    detail: taxAdjustable
      ? `${input.kind.replace(/_/g, ' ')} ${input.number} against ${inv.number}`
      : `${input.kind.replace(/_/g, ' ')} ${input.number} issued after the ${deadline} limit — commercially valid, tax NOT reclaimable`,
    note: {
      noteId: input.noteId,
      number: input.number,
      kind: input.kind,
      againstInvoiceId: inv.invoiceId,
      againstInvoiceNumber: inv.number,
      customerId: input.customerId,
      issuedOn: input.issuedOn,
      reason: input.reason,
      taxableMinor: input.taxableMinor,
      taxes: input.taxes,
      grossMinor: input.taxableMinor + taxMinor,
      taxAdjustable,
      // The month it was ISSUED, not the month the invoice was. This is the rule people
      // get wrong, and it puts the note in the wrong return.
      declareInPeriod: input.issuedOn.slice(0, 7),
      detail: taxAdjustable
        ? `credits ${input.taxableMinor} plus ${taxMinor} tax, declared in ${input.issuedOn.slice(0, 7)}`
        : `credits ${input.taxableMinor}; the ${taxMinor} of tax cannot be reclaimed after ${deadline} (CGST s.34(2))`,
    },
  };
}

export interface ReturnLine {
  readonly returnId: string;
  readonly invoiceId: string;
  readonly productId: string;
  readonly productName: string;
  readonly departmentId: string;
  readonly reason: CreditReason;
  readonly qty: number;
  readonly taxableMinor: number;
  readonly returnedOn: string;
  /** Set once a credit note covers it. An uncredited return is money owed and unrecorded. */
  readonly creditNoteId?: string;
}

export interface ReasonBreakdown {
  readonly reason: CreditReason;
  readonly label: string;
  readonly lines: number;
  readonly valueMinor: number;
  readonly shareBps: number;
  /** Who this is a conversation with. The whole point of splitting by reason. */
  readonly owner: string;
  readonly detail: string;
}

export interface ReturnsReport {
  readonly from: string;
  readonly to: string;
  readonly lines: number;
  readonly totalValueMinor: number;
  /** Returns with no credit note against them — owed to a customer and not in the books. */
  readonly uncreditedMinor: number;
  readonly uncredited: readonly string[];
  readonly byReason: readonly ReasonBreakdown[];
  readonly byDepartment: readonly { readonly departmentId: string; readonly valueMinor: number; readonly shareBps: number }[];
  /** Products returned enough to be a product problem rather than customers changing their minds. */
  readonly repeatOffenders: readonly { readonly productId: string; readonly productName: string; readonly lines: number; readonly valueMinor: number }[];
  readonly detail: string;
}

/** Who each return reason is actually a conversation with. */
const OWNER_OF: Readonly<Record<CreditReason, string>> = {
  goods_returned: 'the returns policy',
  deficiency_in_service: 'the service desk',
  post_supply_discount: 'whoever agreed the discount',
  price_correction: 'pricing — a price was wrong at the till',
  tax_rate_correction: 'the tax setup — a rate was wrong on the master',
  order_cancelled: 'fulfilment',
};

const LABEL_OF: Readonly<Record<CreditReason, string>> = {
  goods_returned: 'goods returned',
  deficiency_in_service: 'service problem',
  post_supply_discount: 'discount agreed after the sale',
  price_correction: 'wrong price charged',
  tax_rate_correction: 'wrong tax rate applied',
  order_cancelled: 'order cancelled',
};

/**
 * The returns report — **split by reason, because a total is unactionable.**
 *
 * *"₹80,000 of returns"* is a number that gets read and forgotten. *"₹52,000 of it was the
 * wrong price charged at the till"* is a pricing job that somebody does this week. Each reason
 * carries **who it is a conversation with**, so the report routes itself.
 *
 * The number that matters most is `uncreditedMinor`: goods that came back with no credit note
 * against them. That is money owed to a customer which is not in the books — and it is
 * invisible in any report built from credit notes, because the credit note is the thing that
 * does not exist.
 */
export function buildReturnsReport(input: {
  readonly lines: readonly ReturnLine[];
  readonly from: string;
  readonly to: string;
  /** Lines for one product before it is a product problem rather than a customer one. Default 5. */
  readonly repeatThreshold?: number;
}): ReturnsReport {
  const window = input.lines.filter((l) => l.returnedOn >= input.from && l.returnedOn <= input.to);
  const totalValueMinor = window.reduce((s, l) => s + l.taxableMinor, 0);
  const share = (value: number): number =>
    totalValueMinor === 0 ? 0 : Number((BigInt(value) * 10_000n) / BigInt(totalValueMinor));

  const byReasonMap = new Map<CreditReason, ReturnLine[]>();
  const byDeptMap = new Map<string, ReturnLine[]>();
  const byProductMap = new Map<string, ReturnLine[]>();
  for (const line of window) {
    byReasonMap.set(line.reason, [...(byReasonMap.get(line.reason) ?? []), line]);
    byDeptMap.set(line.departmentId, [...(byDeptMap.get(line.departmentId) ?? []), line]);
    byProductMap.set(line.productId, [...(byProductMap.get(line.productId) ?? []), line]);
  }

  const byReason = [...byReasonMap]
    .map(([reason, rows]): ReasonBreakdown => {
      const valueMinor = rows.reduce((s, l) => s + l.taxableMinor, 0);
      return {
        reason,
        label: LABEL_OF[reason],
        lines: rows.length,
        valueMinor,
        shareBps: share(valueMinor),
        owner: OWNER_OF[reason],
        detail: `${valueMinor} across ${rows.length} line(s) — this one belongs to ${OWNER_OF[reason]}`,
      };
    })
    .sort((a, b) => b.valueMinor - a.valueMinor || a.reason.localeCompare(b.reason));

  const byDepartment = [...byDeptMap]
    .map(([departmentId, rows]) => {
      const valueMinor = rows.reduce((s, l) => s + l.taxableMinor, 0);
      return { departmentId, valueMinor, shareBps: share(valueMinor) };
    })
    .sort((a, b) => b.valueMinor - a.valueMinor || a.departmentId.localeCompare(b.departmentId));

  const threshold = input.repeatThreshold ?? 5;
  const repeatOffenders = [...byProductMap]
    .filter(([, rows]) => rows.length >= threshold)
    .map(([productId, rows]) => ({
      productId,
      productName: rows[0]!.productName,
      lines: rows.length,
      valueMinor: rows.reduce((s, l) => s + l.taxableMinor, 0),
    }))
    .sort((a, b) => b.lines - a.lines || a.productId.localeCompare(b.productId));

  const uncreditedLines = window.filter((l) => l.creditNoteId === undefined);
  const uncreditedMinor = uncreditedLines.reduce((s, l) => s + l.taxableMinor, 0);

  const worst = byReason[0];

  return {
    from: input.from,
    to: input.to,
    lines: window.length,
    totalValueMinor,
    uncreditedMinor,
    uncredited: uncreditedLines.map((l) => l.returnId).sort(),
    byReason,
    byDepartment,
    repeatOffenders,
    detail:
      window.length === 0
        ? 'no returns recorded in this window'
        : uncreditedMinor > 0
          ? `${totalValueMinor} of returns, of which ${uncreditedMinor} has NO credit note against it — money owed to a customer that is not in the books, and invisible to any report built from credit notes`
          : `${totalValueMinor} of returns; the biggest cause is ${worst?.label} at ${((worst?.shareBps ?? 0) / 100).toFixed(0)}%, which belongs to ${worst?.owner}`,
  };
}

export interface NoteReconciliation {
  readonly period: string;
  readonly notesIssued: number;
  readonly creditedTaxableMinor: number;
  readonly creditedTaxMinor: number;
  /** Notes issued too late to adjust tax. Commercially real, fiscally not. */
  readonly outsideTaxWindowMinor: number;
  readonly reconciles: boolean;
  readonly differenceMinor: number;
  readonly detail: string;
}

/**
 * Reconcile the period's credit notes against what the ledger recorded.
 *
 * Notes are grouped by **when they were issued**, which is the return period they belong to —
 * putting a note in the invoice's period is the mistake that makes a GSTR-1 disagree with the
 * buyer's GSTR-2B, and the buyer always notices first.
 */
export function reconcileNotes(input: {
  readonly period: string;
  readonly notes: readonly CreditNote[];
  /** What the finance ledger posted as credit-note value for this period. */
  readonly ledgerTaxableMinor: number;
  readonly ledgerTaxMinor: number;
}): NoteReconciliation {
  const mine = input.notes.filter((n) => n.declareInPeriod === input.period);
  const adjustable = mine.filter((n) => n.taxAdjustable);

  const creditedTaxableMinor = adjustable.reduce((s, n) => s + n.taxableMinor, 0);
  const creditedTaxMinor = adjustable.reduce(
    (s, n) => s + n.taxes.reduce((t, x) => t + x.amountMinor, 0),
    0,
  );
  const outsideTaxWindowMinor = mine
    .filter((n) => !n.taxAdjustable)
    .reduce((s, n) => s + n.taxableMinor, 0);

  const differenceMinor =
    creditedTaxableMinor - input.ledgerTaxableMinor + (creditedTaxMinor - input.ledgerTaxMinor);

  return {
    period: input.period,
    notesIssued: mine.length,
    creditedTaxableMinor,
    creditedTaxMinor,
    outsideTaxWindowMinor,
    reconciles: differenceMinor === 0,
    differenceMinor,
    detail:
      differenceMinor !== 0
        ? `${mine.length} note(s) total ${creditedTaxableMinor} + ${creditedTaxMinor} tax and the ledger has ${input.ledgerTaxableMinor} + ${input.ledgerTaxMinor} — a ${Math.abs(differenceMinor)} difference that the buyer's GSTR-2B will find before we do`
        : outsideTaxWindowMinor > 0
          ? `${mine.length} note(s) reconcile; ${outsideTaxWindowMinor} of them is outside the section 34(2) window and carries no tax relief`
          : `${mine.length} note(s) reconcile exactly for ${input.period}`,
  };
}
