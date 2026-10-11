// M23-FR-01 — payables: the supplier account's accrued liabilities and debit notes, mapped to balanced journals.
//
// The supplier ACCOUNT is a projection over what head office holds (services/purchase/src/supplier-account.ts):
// every matched invoice's payable — the lowest of order, receipt and invoice — and every debit note a second
// person's return / claim disposition raised. Finance READS that projection and posts what no journal covers yet
// (§28: finance never edits the operational record; corrections are journals). This engine decides WHAT to post:
// per source, the difference between what the register now says and what the ledger already holds — and hands
// each posting to the mapping-driven `postJournal`, so WHICH account anything goes to stays the CA's call (AVR-09,
// P-05). An unmapped kind is a visible exception, never a silent gap (P-08). A re-run posts nothing twice: a source
// whose register figure equals its ledger figure is quiet. A payable that FELL after a re-match is reversed by its
// own journal, never by editing the first (hard rule #2). Pure — no clock, no I/O.

import { postJournal, type PostingInput, type PostingMap, type PostingRule, type JournalEntry as PostedJournal } from './posting';
import type { CurrencyCode } from '../../contracts/src/money';

export type PayablesKind = 'supplier_invoice' | 'supplier_invoice_reversal' | 'supplier_debit_note' | 'supplier_payment' | 'supplier_opening_balance'
  /** OB-44: a signed opening reversed inside the cutover window — the posting undone by its own compensating journal. */
  | 'supplier_opening_reversal';
export type PayablesSourceKind = 'supplier_invoice' | 'supplier_debit_note' | 'supplier_payment' | 'supplier_opening_balance';

/** The supplier account as the payables posting reads it — a structural subset of the purchase service's statement. */
export interface PayablesAccount {
  readonly supplierId: string;
  readonly invoices: readonly {
    readonly invoiceId: string;
    /** What the latest three-way match says may be paid — nothing until the invoice has been matched. */
    readonly payableMinor: number;
    readonly matched: boolean;
    readonly matchedAt: string | null;
    /** The GST inside `payableMinor`, by component (the paper's tax on what may be paid). Absent ⇒ none. */
    readonly tax?: PayablesTax;
  }[];
  readonly debitNotes: readonly {
    readonly debitNoteRef: string;
    /** What the note takes off the supplier — its goods' value plus the GST charged on them. */
    readonly valueMinor: number;
    readonly decidedAt: string;
    /** The GST inside `valueMinor`, by component — the input tax the note reverses. Absent ⇒ none. */
    readonly tax?: PayablesTax;
  }[];
  /** SP-7c — payments a second person approved; each posts once and reduces what is owed. */
  readonly payments: readonly {
    readonly paymentId: string;
    readonly amountMinor: number;
    readonly paidOn: string;
  }[];
  /** GT-05 (MG-08) — legacy bills outstanding at cutover. Only a SIGNED opening is owed and posts. Optional: most have none. */
  readonly openings?: readonly {
    readonly openingId: string;
    readonly amountMinor: number;
    readonly signed: boolean;
    /** OB-44: reversed inside the cutover window (a named person and a second approver) — no longer owed; never erased. */
    readonly reversed?: boolean;
    /** The date the opening books are true at (YYYY-MM-DD) — the period it posts to. */
    readonly openingDate: string;
  }[];
}

/** GST inside a payable or a debit note, by component (M23-FR-02): the input tax the books claim, or a note reverses. */
export interface PayablesTax {
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
}
const TAX_KEYS = ['cgst', 'sgst', 'igst'] as const;
const taxIn = (t: PayablesTax | undefined): Record<(typeof TAX_KEYS)[number], number> => ({ cgst: t?.cgstMinor ?? 0, sgst: t?.sgstMinor ?? 0, igst: t?.igstMinor ?? 0 });

/** What a posted payables journal says about itself — enough to know what the ledger already holds per source. */
export interface PostedPayable {
  readonly kind: PayablesKind;
  readonly sourceKind: PayablesSourceKind;
  readonly sourceId: string;
  readonly supplierId: string;
  readonly components: Readonly<Record<string, number>>;
}

export interface PayablesPosting {
  readonly kind: PayablesKind;
  readonly sourceKind: PayablesSourceKind;
  readonly sourceId: string;
  readonly supplierId: string;
  /** The day the thing happened — the match or the disposition — which decides the period it belongs to (YYYY-MM-DD). */
  readonly documentDate: string;
  readonly components: Readonly<Record<string, number>>;
}

/**
 * The SUGGESTED rules for the supplier account — a goods-received-not-invoiced (GRNI) clearing pattern. A matched
 * invoice credits the supplier and debits the clearing; a reversal and a debit note are the mirror image. The
 * accountant PUTs these (or their own) before anything posts; the reconciliation reads the control account FROM the
 * mapping in force, never from this constant.
 */
export const PAYABLES_POSTING_RULES: readonly PostingRule[] = Object.freeze([
  {
    // A matched bill: the goods' taxable value to purchases (through the GRNI clearing), the GST the paper charged to the
    // input-tax accounts — CGST and SGST on an intra-state bill, IGST on an inter-state one — and the whole to the supplier.
    kind: 'supplier_invoice',
    legs: [
      { account: 'purchases_grni', side: 'debit', component: 'taxable' },
      { account: 'gst_input_cgst', side: 'debit', component: 'cgst' },
      { account: 'gst_input_sgst', side: 'debit', component: 'sgst' },
      { account: 'gst_input_igst', side: 'debit', component: 'igst' },
      { account: 'supplier_payable', side: 'credit', component: 'payable' },
    ],
  },
  {
    kind: 'supplier_invoice_reversal',
    legs: [
      { account: 'supplier_payable', side: 'debit', component: 'amount' },
      { account: 'purchases_grni', side: 'credit', component: 'taxable' },
      { account: 'gst_input_cgst', side: 'credit', component: 'cgst' },
      { account: 'gst_input_sgst', side: 'credit', component: 'sgst' },
      { account: 'gst_input_igst', side: 'credit', component: 'igst' },
    ],
  },
  {
    // A debit note is the bill's reversal for what went back: the goods and the input tax claimed on them.
    kind: 'supplier_debit_note',
    legs: [
      { account: 'supplier_payable', side: 'debit', component: 'amount' },
      { account: 'purchases_grni', side: 'credit', component: 'taxable' },
      { account: 'gst_input_cgst', side: 'credit', component: 'cgst' },
      { account: 'gst_input_sgst', side: 'credit', component: 'sgst' },
      { account: 'gst_input_igst', side: 'credit', component: 'igst' },
    ],
  },
  {
    // SP-7c: a payment settles the supplier and leaves through the bank clearing — the bank statement (M23-FR-03) is the
    // second source that clears it, when that reconciliation exists.
    kind: 'supplier_payment',
    legs: [
      { account: 'supplier_payable', side: 'debit', component: 'amount' },
      { account: 'bank_clearing', side: 'credit', component: 'amount' },
    ],
  },
  {
    // GT-05 (MG-08): a signed opening balance credits the supplier against the opening-balances account the accountant
    // carries the old system's trial balance in. A SUGGESTION, like the rest: the accountant's mapping decides.
    kind: 'supplier_opening_balance',
    legs: [
      { account: 'opening_balances', side: 'debit', component: 'amount' },
      { account: 'supplier_payable', side: 'credit', component: 'amount' },
    ],
  },
  {
    // OB-44 (owner, 11 Oct 2026): an opening reversed inside the cutover window — the opening's own journal, undone.
    kind: 'supplier_opening_reversal',
    legs: [
      { account: 'supplier_payable', side: 'debit', component: 'amount' },
      { account: 'opening_balances', side: 'credit', component: 'amount' },
    ],
  },
]);

/** What the ledger already holds for a source: accruals less reversals for an invoice; the amount for a debit note or a payment. */
export function ledgerHolds(prior: readonly PostedPayable[], sourceKind: PayablesSourceKind, sourceId: string): number {
  let held = 0;
  for (const p of prior) {
    if (p.sourceKind !== sourceKind || p.sourceId !== sourceId) continue;
    if (p.kind === 'supplier_invoice') held += p.components['payable'] ?? 0;
    else if (p.kind === 'supplier_invoice_reversal' || p.kind === 'supplier_opening_reversal') held -= p.components['amount'] ?? 0;
    else held += p.components['amount'] ?? 0;
  }
  return held;
}

/** What the ledger already holds of a source's GST, by component (an accrual adds, a reversal takes away). */
export function ledgerHoldsTax(prior: readonly PostedPayable[], sourceKind: PayablesSourceKind, sourceId: string): Record<(typeof TAX_KEYS)[number], number> {
  const held = { cgst: 0, sgst: 0, igst: 0 };
  for (const p of prior) {
    if (p.sourceKind !== sourceKind || p.sourceId !== sourceId) continue;
    const sign = p.kind === 'supplier_invoice_reversal' ? -1 : 1;
    for (const k of TAX_KEYS) held[k] += sign * (p.components[k] ?? 0);
  }
  return held;
}

/**
 * A gross change split into its taxable value and its GST by component — the components a payables rule posts. `gross` and
 * every tax figure are deltas of the same sign; the taxable part is what is left. A source with no tax posts taxable = gross.
 */
function split(grossKey: 'payable' | 'amount', gross: number, tax: Record<(typeof TAX_KEYS)[number], number>): Readonly<Record<string, number>> {
  return { [grossKey]: gross, taxable: gross - tax.cgst - tax.sgst - tax.igst, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst };
}

/**
 * The postings that bring the ledger level with the register — one per source that differs, none for a source that
 * agrees. An invoice whose matched payable ROSE since the last posting accrues the difference; one whose payable FELL
 * (a re-match that withheld more) reverses the difference as its own journal. An unmatched invoice posts nothing:
 * nothing is owed until the three documents have been compared. A debit note posts once, at its value.
 */
export function planPayablesPostings(accounts: readonly PayablesAccount[], prior: readonly PostedPayable[]): readonly PayablesPosting[] {
  const out: PayablesPosting[] = [];
  for (const a of accounts) {
    for (const inv of a.invoices) {
      if (!inv.matched || inv.matchedAt === null) continue;
      const delta = inv.payableMinor - ledgerHolds(prior, 'supplier_invoice', inv.invoiceId);
      const heldTax = ledgerHoldsTax(prior, 'supplier_invoice', inv.invoiceId);
      const nowTax = taxIn(inv.tax);
      const dTax = { cgst: nowTax.cgst - heldTax.cgst, sgst: nowTax.sgst - heldTax.sgst, igst: nowTax.igst - heldTax.igst };
      if (delta === 0 && dTax.cgst === 0 && dTax.sgst === 0 && dTax.igst === 0) continue;
      const base = { sourceKind: 'supplier_invoice' as const, sourceId: inv.invoiceId, supplierId: a.supplierId, documentDate: inv.matchedAt.slice(0, 10) };
      out.push(delta >= 0
        ? { ...base, kind: 'supplier_invoice', components: split('payable', delta, dTax) }
        : { ...base, kind: 'supplier_invoice_reversal', components: split('amount', -delta, { cgst: 0 - dTax.cgst, sgst: 0 - dTax.sgst, igst: 0 - dTax.igst }) });
    }
    for (const dn of a.debitNotes) {
      const delta = dn.valueMinor - ledgerHolds(prior, 'supplier_debit_note', dn.debitNoteRef);
      if (delta <= 0) continue; // a debit note is raised once, at its value — it never grows
      const heldTax = ledgerHoldsTax(prior, 'supplier_debit_note', dn.debitNoteRef);
      const nowTax = taxIn(dn.tax);
      out.push({
        kind: 'supplier_debit_note', sourceKind: 'supplier_debit_note', sourceId: dn.debitNoteRef, supplierId: a.supplierId,
        documentDate: dn.decidedAt.slice(0, 10),
        components: split('amount', delta, { cgst: nowTax.cgst - heldTax.cgst, sgst: nowTax.sgst - heldTax.sgst, igst: nowTax.igst - heldTax.igst }),
      });
    }
    for (const pay of a.payments) {
      const delta = pay.amountMinor - ledgerHolds(prior, 'supplier_payment', pay.paymentId);
      if (delta <= 0) continue; // a payment is a fact recorded once, at its amount
      out.push({
        kind: 'supplier_payment', sourceKind: 'supplier_payment', sourceId: pay.paymentId, supplierId: a.supplierId,
        documentDate: pay.paidOn, components: { amount: delta },
      });
    }
    for (const op of a.openings ?? []) {
      if (!op.signed) continue; // an unsigned opening is shown, never owed and never posted
      if (op.reversed === true) {
        // OB-44: reversed in the cutover window — whatever the ledger still holds for it is taken back out, once.
        const held = ledgerHolds(prior, 'supplier_opening_balance', op.openingId);
        if (held > 0) {
          out.push({
            kind: 'supplier_opening_reversal', sourceKind: 'supplier_opening_balance', sourceId: op.openingId, supplierId: a.supplierId,
            documentDate: op.openingDate, components: { amount: held },
          });
        }
        continue;
      }
      const delta = op.amountMinor - ledgerHolds(prior, 'supplier_opening_balance', op.openingId);
      if (delta <= 0) continue; // an opening is a fact recorded once, at its amount — it never grows
      out.push({
        kind: 'supplier_opening_balance', sourceKind: 'supplier_opening_balance', sourceId: op.openingId, supplierId: a.supplierId,
        documentDate: op.openingDate, components: { amount: delta },
      });
    }
  }
  return out;
}

export type PayablesExceptionReason = 'unmapped_kind' | 'missing_component' | 'unbalanced_journal' | 'tax_not_mapped';

export interface PayablesException {
  readonly sourceKind: PayablesSourceKind;
  readonly sourceIds: readonly string[];
  readonly kind: PayablesKind;
  readonly supplierId: string;
  readonly reason: PayablesExceptionReason;
  readonly detail: string;
}

export interface PayablesPosted {
  readonly posting: PayablesPosting;
  readonly entry: PostedJournal;
}

/** Hand each planned posting to the mapping-driven engine: a balanced journal each, or a named exception each. */
export function postPayables(postings: readonly PayablesPosting[], map: PostingMap, currency: CurrencyCode): {
  readonly journals: readonly PayablesPosted[];
  readonly exceptions: readonly PayablesException[];
} {
  const journals: PayablesPosted[] = [];
  const exceptions: PayablesException[] = [];
  for (const posting of postings) {
    const input: PostingInput = {
      id: `${posting.kind}@${posting.sourceId}`, kind: posting.kind,
      at: `${posting.documentDate}T00:00:00.000Z`, currency, components: posting.components,
    };
    // GST the bill charged must land on an input-tax leg the accountant mapped. A rule with no leg for a tax component would
    // still balance (its gross leg carries the tax) and quietly bury the input tax in purchases — so it is REFUSED, by name.
    const rule = map.rules.find((r) => r.kind === posting.kind);
    const unmappedTax = rule === undefined ? [] : TAX_KEYS.filter((k) => (posting.components[k] ?? 0) !== 0 && !rule.legs.some((l) => l.component === k));
    if (unmappedTax.length > 0) {
      exceptions.push({
        sourceKind: posting.sourceKind, sourceIds: [posting.sourceId], kind: posting.kind, supplierId: posting.supplierId, reason: 'tax_not_mapped',
        detail: `${posting.kind} for ${posting.sourceId} (supplier ${posting.supplierId}) carries ${unmappedTax.map((k) => k.toUpperCase()).join(' and ')} but the ledger mapping's '${posting.kind}' rule has no input-tax leg for it — nothing was posted; the accountant maps it (PUT /v1/finance/posting-map) and posts again`,
      });
      continue;
    }
    try {
      journals.push({ posting, entry: postJournal(input, map) });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      const reason: PayablesExceptionReason =
        name === 'UnmappedKindError' ? 'unmapped_kind'
          : name === 'MissingComponentError' ? 'missing_component'
            : 'unbalanced_journal';
      const message = err instanceof Error ? err.message : String(err);
      exceptions.push({
        sourceKind: posting.sourceKind, sourceIds: [posting.sourceId], kind: posting.kind, supplierId: posting.supplierId, reason,
        detail: `${posting.kind} for ${posting.sourceId} (supplier ${posting.supplierId}) could not be posted: ${message}`,
      });
    }
  }
  return { journals, exceptions };
}

/** The account the mapping CREDITS for a supplier invoice — the payables control account the reconciliation reads. */
export function payablesControlAccount(map: PostingMap): string | undefined {
  const rule = map.rules.find((r) => r.kind === 'supplier_invoice');
  return rule?.legs.find((l) => l.side === 'credit' && l.component === 'payable')?.account;
}

/** A posted payables journal as the reconciliation reads it: what it covers, and its lines. */
export interface PostedPayablesJournal extends PostedPayable {
  readonly lines: readonly { readonly accountCode: string; readonly debitMinor: number; readonly creditMinor: number }[];
}

export interface SupplierReconciliation {
  readonly supplierId: string;
  /** The PURCHASE register: every matched invoice's payable less every debit note and every payment. */
  readonly registerOwedMinor: number;
  /** The FINANCE ledger: credits less debits on the control account across this supplier's payables journals. */
  readonly ledgerOwedMinor: number;
  readonly differenceMinor: number;
  readonly agrees: boolean;
  /** The postings the ledger still lacks — exactly what a posting run would post now. */
  readonly unposted: readonly PayablesPosting[];
}

export interface PayablesReconciliation {
  /** The control account named by the mapping in force; `null` when no mapping names one (then nothing agrees). */
  readonly controlAccount: string | null;
  readonly leftDerivation: string;
  readonly rightDerivation: string;
  readonly suppliers: readonly SupplierReconciliation[];
  readonly registerOwedMinor: number;
  readonly ledgerOwedMinor: number;
  readonly differenceMinor: number;
  readonly agrees: boolean;
}

export const PAYABLES_LEFT_DERIVATION = 'purchase register: every matched invoice\'s payable (the lowest of order, receipt and invoice) less every debit note a return or claim raised and every payment a second person approved, plus every opening balance a second person signed off';
export const PAYABLES_RIGHT_DERIVATION = 'finance ledger: credits less debits on the payables control account across the posted payables journals';

/**
 * Two figures reached two different ways (QG-07): what the purchase register says the shop owes each supplier against
 * what the finance ledger holds on the control account. They differ by exactly what has not been posted — listed — or
 * by a mapping that names no control account, in which case nothing agrees and the reason is the null account.
 */
export function reconcilePayables(
  accounts: readonly PayablesAccount[], journals: readonly PostedPayablesJournal[], map: PostingMap | undefined,
): PayablesReconciliation {
  const control = map === undefined ? undefined : payablesControlAccount(map);
  const suppliers: SupplierReconciliation[] = accounts.map((a) => {
    const registerOwedMinor = a.invoices.filter((i) => i.matched).reduce((s, i) => s + i.payableMinor, 0)
      - a.debitNotes.reduce((s, d) => s + d.valueMinor, 0)
      - a.payments.reduce((s, p) => s + p.amountMinor, 0)
      + (a.openings ?? []).filter((o) => o.signed && o.reversed !== true).reduce((s, o) => s + o.amountMinor, 0);
    const ledgerOwedMinor = control === undefined ? 0 : journals
      .filter((j) => j.supplierId === a.supplierId)
      .flatMap((j) => j.lines)
      .filter((l) => l.accountCode === control)
      .reduce((s, l) => s + l.creditMinor - l.debitMinor, 0);
    const unposted = planPayablesPostings([a], journals);
    return {
      supplierId: a.supplierId, registerOwedMinor, ledgerOwedMinor, differenceMinor: registerOwedMinor - ledgerOwedMinor,
      agrees: control !== undefined && registerOwedMinor === ledgerOwedMinor && unposted.length === 0, unposted,
    };
  });
  const registerOwedMinor = suppliers.reduce((s, x) => s + x.registerOwedMinor, 0);
  const ledgerOwedMinor = suppliers.reduce((s, x) => s + x.ledgerOwedMinor, 0);
  return {
    controlAccount: control ?? null,
    leftDerivation: PAYABLES_LEFT_DERIVATION, rightDerivation: PAYABLES_RIGHT_DERIVATION,
    suppliers, registerOwedMinor, ledgerOwedMinor, differenceMinor: registerOwedMinor - ledgerOwedMinor,
    agrees: control !== undefined && suppliers.every((s) => s.agrees),
  };
}
