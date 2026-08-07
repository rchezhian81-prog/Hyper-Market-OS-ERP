// The buyer's surface (docs/design/screens/purchase-receiving.md · M06 · M07 · M30 · D03 · §28).
//
// The rules exist and are tested: `packages/purchasing` issues a PO, `packages/import` validates a
// file and commits it atomically, `packages/receiving` books goods in, `services/purchase` runs the
// three-way match. What has never existed is the thing that joins them — **something that captures
// a supplier invoice** — and until it did, `matchLines` returned an empty set for every invoice and
// the match refused every time, correctly and uselessly.
//
// ── What this screen is for, in the shop's own words ────────────────────────
//
// Audit finding A-03 is *line-by-line invoice pain*: somebody types an eighty-line supplier invoice
// into a computer, by hand, every week. The spec's stated priority is to kill that — upload the
// file, see what is wrong **before** anything is written, get it approved, commit it in one go.
//
// ── The two controls that make bulk capture safe ────────────────────────────
//
// **1. The lines must add up to the total printed on the paper.** The buyer types the invoice total
// off the bottom of the supplier's document, and the file's lines are summed against it. They
// disagree for exactly two reasons — a line is wrong, or a line is missing — and both are the
// difference between paying what was agreed and paying what somebody typed. This is the same
// control-total discipline the migration uses, applied where the money actually leaves.
//
// It is also the reason a *partial* commit would be worse than a refusal: seventy-seven of eighty
// lines written is an invoice in the system that matches no piece of paper anywhere, and nobody can
// say which three are missing. `commitImport` is atomic, and this composes it rather than
// re-implementing it.
//
// **2. Each line's own arithmetic is checked.** An invoice prints quantity, unit price and a line
// total, and a mistyped quantity is invisible in a column of numbers but obvious the moment those
// three are multiplied. The generic import engine cannot know that rule; this layer does, and it
// reports the offending **line number** so somebody can go and look at the paper.
//
// ── And the one that stops it becoming a rubber stamp ───────────────────────
//
// **Nothing is paid against an invoice this system has not actually compared.** The three-way match
// already refuses an empty line set rather than calling it agreement, and this surface never
// papers over that refusal — it shows it as the sentence it is: *not checked* is not *clean*.

import { money, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import { parseDelimited, MalformedFileError } from '../../../packages/import/src/delimited';
import {
  commitImport, validateImport,
  type ImportPreview, type RowError, type TemplateSpec,
} from '../../../packages/import/src/import-job';
import {
  issuePurchaseOrder, computeOpenCommitment,
  type IssuedPurchaseOrder, type OpenCommitment, type PurchaseOrderLineInput,
} from '../../../packages/purchasing/src/purchasing';
// From the package, not the service: the service imports the HTTP kernel, and a browser bundle
// cannot contain `node:http`. Same rule, one implementation — see `three-way-match.ts`.
import { threeWayMatch, type MatchLine, type MatchResult } from '../../../packages/purchasing/src/three-way-match';

/**
 * The shape a supplier invoice file must have.
 *
 * Four columns and no more. Every extra column is one more thing to explain to somebody who is
 * already retyping eighty lines by hand, and the line total is the one that earns its place —
 * without it there is nothing to check the quantity and the price against.
 */
export const SUPPLIER_INVOICE_TEMPLATE = Object.freeze({
  id: 'supplier-invoice-v1',
  domain: 'supplier_invoice',
  columns: [
    { name: 'productId', type: 'text' as const, required: true, referenceSet: 'products' },
    { name: 'quantity', type: 'integer' as const, required: true },
    { name: 'unitPriceMinor', type: 'money_minor' as const, required: true },
    { name: 'lineTotalMinor', type: 'money_minor' as const, required: true },
  ],
  keyColumns: ['productId'],
  // The column summed against the total printed on the paper.
  amountColumn: 'lineTotalMinor',
}) satisfies TemplateSpec;

/** One line of a captured supplier invoice. */
export interface InvoiceLine {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
}

export interface CapturePreview {
  readonly preview: ImportPreview;
  /** The lines that would be captured, already typed rather than left as strings. */
  readonly lines: readonly InvoiceLine[];
  /** What the file's lines add up to. */
  readonly sumMinor: number;
  /** What the buyer typed off the bottom of the supplier's invoice. */
  readonly declaredTotalMinor: number;
  /** True only when the file is clean AND its lines add up to the printed total. */
  readonly readyToApprove: boolean;
  /** Every problem, each with the line number to look at on the paper. */
  readonly problems: readonly RowError[];
}

export class UnreadableInvoiceFileError extends Error {
  constructor(detail: string) {
    super(`That file could not be read: ${detail}`);
    this.name = 'UnreadableInvoiceFileError';
  }
}

/**
 * Check each line's own arithmetic.
 *
 * `quantity × unitPriceMinor` must equal `lineTotalMinor`. The generic import engine validates
 * types and references; it has no idea what these three columns mean to each other. A mistyped
 * quantity is invisible in a column of numbers and obvious the moment they are multiplied — and it
 * is the single most common transcription error there is.
 */
export function lineArithmeticErrors(
  rows: readonly Readonly<Record<string, string>>[],
  lineNumbers: readonly number[],
): RowError[] {
  const errors: RowError[] = [];
  rows.forEach((row, index) => {
    const quantity = Number(row['quantity']);
    const unit = Number(row['unitPriceMinor']);
    const total = Number(row['lineTotalMinor']);
    if (!Number.isFinite(quantity) || !Number.isFinite(unit) || !Number.isFinite(total)) return;
    if (quantity * unit === total) return;
    errors.push({
      line: lineNumbers[index] ?? index + 2,
      column: 'lineTotalMinor',
      kind: 'not_an_amount',
      message:
        `${quantity} × ${unit} is ${quantity * unit}, but the line says ${total}. ` +
        'One of the three is mistyped — check this line against the paper invoice.',
    });
  });
  return errors;
}

export interface BuyingConfig {
  readonly tenantId: string;
  readonly buyerId: string;
  readonly currency: CurrencyCode;
  /** Quantity tolerance for the three-way match, in basis points. Per-tenant. */
  readonly quantityToleranceBps: number;
  /** Price tolerance for the three-way match, in basis points. Per-tenant. */
  readonly priceToleranceBps: number;
  /** A difference below this is not worth a person's time. Per-tenant. */
  readonly immaterialMinor: number;
}

/** What this surface can see about the shop, and what it honestly cannot. */
export interface BuyingPorts {
  /** Product ids that exist, so an invoice line for something we do not stock is caught. */
  knownProductIds(): readonly string[];
  /** What a purchase order actually ordered, for the match. */
  orderedLines(poId: string): readonly { readonly productId: string; readonly qty: number; readonly unitMinor: number }[];
  /** What was actually received against it, for the match. */
  receivedLines(poId: string): readonly { readonly productId: string; readonly qty: number }[];
  /** Invoice lines already captured, so a second capture of one invoice is visible. */
  capturedLines(invoiceId: string): readonly InvoiceLine[];
}

export type CaptureRefusal =
  | 'file_has_problems'
  | 'does_not_add_up_to_the_invoice_total'
  | 'not_approved'
  | 'approved_by_the_person_who_captured_it'
  | 'nothing_to_capture'
  | 'already_captured';

/**
 * The same set at runtime, so the view can be checked against it.
 *
 * `Record<CaptureRefusal, CaptureRefusal>` makes the compiler insist this stays complete: add a
 * refusal to the union and this stops building, rather than a buyer being shown a blank reason for
 * an invoice that would not save. Parsing the union out of the source with a regex was tried on
 * the manager's screen and broke on the first reformat.
 */
const REFUSALS: Readonly<Record<CaptureRefusal, CaptureRefusal>> = Object.freeze({
  file_has_problems: 'file_has_problems',
  does_not_add_up_to_the_invoice_total: 'does_not_add_up_to_the_invoice_total',
  not_approved: 'not_approved',
  approved_by_the_person_who_captured_it: 'approved_by_the_person_who_captured_it',
  nothing_to_capture: 'nothing_to_capture',
  already_captured: 'already_captured',
});

export const CAPTURE_REFUSALS: readonly CaptureRefusal[] = Object.freeze(Object.values(REFUSALS));

export type CaptureOutcome =
  | { readonly ok: true; readonly invoiceId: string; readonly lines: readonly InvoiceLine[]; readonly totalMinor: number }
  | { readonly ok: false; readonly refusal: CaptureRefusal; readonly detail: string };

export interface BuyingSession {
  /** Issue a purchase order (M06-FR-02). Needs somebody else's approval — §28. */
  raisePurchaseOrder(input: {
    readonly id: string;
    readonly number: string;
    readonly supplierId: string;
    readonly at: string;
    readonly lines: readonly { readonly productId: string; readonly orderedQty: number; readonly unitCostMinor: number }[];
    readonly supplierBlocked?: boolean;
    readonly approval?: DecidedRequest;
  }): IssuedPurchaseOrder;

  /** What is on order and not yet received — no longer *not known* (M06). */
  openCommitment(input: Parameters<typeof computeOpenCommitment>[0]): OpenCommitment;

  /**
   * Read a supplier invoice file and say what is wrong with it. **Writes nothing.**
   *
   * This is the whole point of the screen: the buyer sees every bad row, by line number, before
   * anything is committed anywhere.
   */
  previewInvoice(input: {
    readonly text: string;
    readonly declaredTotalMinor: number;
    readonly delimiter?: string;
  }): CapturePreview;

  /** Commit a previewed, approved invoice — all of it or none of it. */
  captureInvoice(input: {
    readonly invoiceId: string;
    readonly supplierId: string;
    readonly preview: CapturePreview;
    readonly approval?: DecidedRequest;
  }): CaptureOutcome;

  /** Compare the order, the delivery and the invoice (M07-FR-04). */
  match(input: { readonly poId: string; readonly invoiceId: string }): MatchResult;
}

export function createBuyingSession(config: BuyingConfig, ports: BuyingPorts): BuyingSession {
  const inr = (minor: number): Money => money(minor, config.currency);

  const previewInvoice: BuyingSession['previewInvoice'] = (input) => {
    let parsed;
    try {
      parsed = parseDelimited(input.text, {
        ...(input.delimiter === undefined ? {} : { delimiter: input.delimiter }),
      });
    } catch (e) {
      // A file that will not parse is not an empty file. Returning zero rows here would let the
      // next step report "nothing to import" — which sounds like a quiet day rather than a
      // supplier's invoice nobody has read.
      throw new UnreadableInvoiceFileError(
        e instanceof MalformedFileError ? e.message : (e instanceof Error ? e.message : String(e)),
      );
    }

    const preview = validateImport({
      template: SUPPLIER_INVOICE_TEMPLATE,
      rows: parsed.rows,
      lineNumbers: parsed.lineNumbers,
      references: { products: ports.knownProductIds() },
      declaredTotalMinor: input.declaredTotalMinor,
    });

    // The engine's problems, plus the one only this layer understands.
    const problems = [...preview.errors, ...lineArithmeticErrors(parsed.rows, parsed.lineNumbers)];

    const lines: InvoiceLine[] = preview.validRows.map((row) => ({
      productId: row['productId'] ?? '',
      quantity: Number(row['quantity']),
      unitPriceMinor: Number(row['unitPriceMinor']),
      lineTotalMinor: Number(row['lineTotalMinor']),
    }));

    return {
      preview,
      lines,
      sumMinor: preview.sumMinor ?? 0,
      declaredTotalMinor: input.declaredTotalMinor,
      // Both conditions, and the second is the one people want to skip: a clean file whose lines
      // do not add up to the paper is a file that is missing a line.
      readyToApprove: problems.length === 0 && preview.reconciles === true && lines.length > 0,
      problems,
    };
  };

  return {
    raisePurchaseOrder: (input) => issuePurchaseOrder({
      id: input.id,
      number: input.number,
      supplierId: input.supplierId,
      requisitionedBy: config.buyerId,
      at: input.at,
      lines: input.lines.map((l): PurchaseOrderLineInput => ({
        productId: l.productId,
        orderedQty: l.orderedQty,
        unitCost: inr(l.unitCostMinor),
      })),
      ...(input.supplierBlocked === undefined ? {} : { supplierBlocked: input.supplierBlocked }),
      ...(input.approval === undefined ? {} : { approval: input.approval }),
    }),

    openCommitment: (input) => computeOpenCommitment(input),

    previewInvoice,

    captureInvoice: (input) => {
      if (ports.capturedLines(input.invoiceId).length > 0) {
        return {
          ok: false,
          refusal: 'already_captured',
          detail: `invoice ${input.invoiceId} has already been captured. Capturing it twice would double what this supplier is owed.`,
        };
      }
      if (input.preview.problems.length > 0) {
        return {
          ok: false,
          refusal: 'file_has_problems',
          detail: `${input.preview.problems.length} line(s) need fixing on the paper invoice before any of it can be captured. Nothing has been written.`,
        };
      }
      if (input.preview.preview.reconciles !== true) {
        return {
          ok: false,
          refusal: 'does_not_add_up_to_the_invoice_total',
          detail:
            `the lines add up to ${input.preview.sumMinor} and the invoice says ${input.preview.declaredTotalMinor}. ` +
            'Either a line is wrong or a line is missing — and both mean paying something other than what was agreed.',
        };
      }

      let captured: readonly InvoiceLine[] = [];
      const result = commitImport(
        {
          preview: input.preview.preview,
          uploadedBy: config.buyerId,
          jobId: input.invoiceId,
          ...(input.approval === undefined ? {} : { approval: input.approval }),
        },
        // Atomic by construction: `commitImport` calls this once with every valid row, or never.
        // Seventy-seven of eighty lines written is an invoice matching no piece of paper anywhere,
        // and nobody can say which three are missing.
        () => { captured = input.preview.lines; },
      );

      if (!result.committed) {
        const refusal: CaptureRefusal = result.refusal === 'self_approved'
          ? 'approved_by_the_person_who_captured_it'
          : result.refusal === 'nothing_to_import' ? 'nothing_to_capture' : 'not_approved';
        return {
          ok: false,
          refusal,
          detail: refusal === 'approved_by_the_person_who_captured_it'
            ? 'the person who captured this invoice cannot also approve it (§28). Somebody else has to look at it.'
            : refusal === 'nothing_to_capture'
              ? 'there is nothing in this file to capture.'
              : 'this invoice has not been approved by anybody yet, so nothing has been written.',
        };
      }

      return {
        ok: true,
        invoiceId: input.invoiceId,
        lines: captured,
        totalMinor: input.preview.declaredTotalMinor,
      };
    },

    /**
     * Compare the order, the delivery and the invoice.
     *
     * The lines are assembled from all three sides — and where a side has nothing for a product,
     * it contributes **zero rather than being skipped**. A product on the invoice that was never
     * ordered and never received must appear in the match as exactly that; dropping it would make
     * the invoice agree with a delivery that did not happen.
     */
    match: (input) => {
      const ordered = ports.orderedLines(input.poId);
      const received = ports.receivedLines(input.poId);
      const invoiced = ports.capturedLines(input.invoiceId);

      // **No invoice means no match, and it must reach the engine as no lines.**
      //
      // The first version built the line set from the union of all three sides, so an invoice
      // nobody had captured still produced two rows — invoiced quantity zero, nothing to pay,
      // nothing withheld — and the match came back *not blocked*. Which is true and useless: it is
      // the engine's own "an empty line set is not agreement" guard, defeated from the outside by
      // handing it lines it should never have had. Found by a test, not by reading.
      //
      // Three documents cannot agree when we are holding two of them.
      if (invoiced.length === 0) {
        return threeWayMatch({
          lines: [],
          quantityToleranceBps: config.quantityToleranceBps,
          priceToleranceBps: config.priceToleranceBps,
          immaterialMinor: config.immaterialMinor,
        });
      }

      const productIds = [...new Set([
        ...ordered.map((l) => l.productId),
        ...received.map((l) => l.productId),
        ...invoiced.map((l) => l.productId),
      ])].sort();

      const lines: MatchLine[] = productIds.map((productId) => {
        const o = ordered.find((l) => l.productId === productId);
        const r = received.find((l) => l.productId === productId);
        const i = invoiced.find((l) => l.productId === productId);
        return {
          productId,
          orderedQty: o?.qty ?? 0,
          receivedQty: r?.qty ?? 0,
          invoicedQty: i?.quantity ?? 0,
          orderedUnitMinor: o?.unitMinor ?? 0,
          invoicedUnitMinor: i?.unitPriceMinor ?? 0,
        };
      });

      return threeWayMatch({
        lines,
        quantityToleranceBps: config.quantityToleranceBps,
        priceToleranceBps: config.priceToleranceBps,
        immaterialMinor: config.immaterialMinor,
      });
    },
  };
}
