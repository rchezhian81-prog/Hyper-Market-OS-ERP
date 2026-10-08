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
// file, see what is wrong **before** anything is written, commit it in one go.
//
// ── Who captures it, and who checks it ──────────────────────────────────────
//
// The bill is captured by the **signed-in buyer**, and nobody else: it carries no checker. This screen
// used to ask "Who checked this invoice?" and send a typed second name along with it, and head office
// rightly stopped trusting that name — a name typed on the buyer's own screen is the buyer's say-so, so
// the synced invoice route records any such name only as a *claim* and flags the bill unapproved. The
// check is a **second person's own act at head office**: the match, under their own sign-in (§28). So the
// screen does not ask for a checker at all, rather than asking for one nobody believes.
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
// say which three are missing. So the capture is atomic by construction: every line of the previewed
// file travels in ONE queued event, written once, or nothing is queued at all. (`commitImport` is not
// used here: it is the maker-checker import, and this capture carries no checker — the check is the
// second person's own act at head office.)
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
  validateImport,
  type ImportPreview, type RowError, type TemplateSpec,
} from '../../../packages/import/src/import-job';
import {
  issuePurchaseOrder, computeOpenCommitment,
  type IssuedPurchaseOrder, type OpenCommitment, type PurchaseOrderLineInput,
} from '../../../packages/purchasing/src/purchasing';
// From the package, not the service: the service imports the HTTP kernel, and a browser bundle
// cannot contain `node:http`. Same rule, one implementation — see `three-way-match.ts`.
import { threeWayMatch, type MatchLine, type MatchResult } from '../../../packages/purchasing/src/three-way-match';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemReason, deviceItemState, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';

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
  /** The store this screen serves — stamped on what it queues so head office knows where the paper is. */
  readonly storeId?: string;
  /** Injected clock; the device's own by default. */
  readonly now?: () => string;
}

/**
 * The event a captured supplier invoice travels under (SP-7a · F02): the invoice's OWN lines as the paper says them, and
 * the signed-in buyer who captured it — queued on the durable device queue BEFORE the screen says "saved", relayed through
 * the store box to head office's synced invoice route. It carries NO checker: checking the bill is a second person's own
 * act at head office (the match, under their own sign-in, §28), never a name typed on the buyer's screen. Nothing about
 * the order or the delivery rides with it: those are head office's own records (F04).
 */
export const SUPPLIER_INVOICE_CAPTURED = 'SupplierInvoiceCaptured';
/** The invoice's one identity at every hop (device queue → box → cloud). */
export const invoiceKeyFor = (invoiceId: string): string => `invoice:${invoiceId}`;

export interface SupplierInvoiceCapturedPayload {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly poId: string | null;
  readonly lines: readonly InvoiceLine[];
  readonly declaredTotalMinor: number;
  readonly capturedBy: string;
  readonly capturedAt: string;
  readonly storeId: string | null;
  readonly source: 'buyer-screen';
}

/** One invoice this screen saved, and where it has got to (the five shared state words, SP-2a). */
export interface SavedInvoice {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly poId: string | null;
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
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
  /**
   * PROPOSE a purchase order at head office (M06-FR-02, API-03). Absent when this box cannot reach the
   * cloud — then `canProposeToCloud` is false and the screen keeps its local-only compute rather than
   * pretending an order was raised (P-01/P-08). The requisitioner is attributed to the AUTHENTICATED
   * buyer by the cloud, never a name in the body.
   */
  proposeOrder?(): ProposePurchaseOrderPort;
}

/**
 * A purchase order to PROPOSE at head office (M06-FR-02, API-03). What the buyer typed — the PO id,
 * the supplier and the lines. The requisitioner is the AUTHENTICATED buyer (the cloud attributes it,
 * never a name in the body), and NO approver rides with it: a proposed PO awaits a SECOND person's
 * approval (§28), which the buyer may not give from this screen. Only an issued PO becomes an open
 * commitment, so proposing commits no money.
 */
export interface ProposePurchaseOrderInput {
  readonly poId: string;
  readonly supplierId: string;
  readonly lines: readonly { readonly productId: string; readonly orderedQty: number; readonly unitCostMinor: number }[];
}

/** What head office said when asked to propose a PO — the proposed order, or the reason it did not land. */
export type ProposePurchaseOrderOutcome =
  | { readonly proposed: true; readonly requisitionedBy: string; readonly totalMinor: number }
  | { readonly proposed: false; readonly reason: string };

/**
 * The authenticated POST that records a PROPOSED purchase order at head office (M06-FR-02, API-03). Injected,
 * so the model opens no socket itself; the cloud attributes the requisitioner to the authenticated caller and a
 * blocked supplier is the cloud's to refuse. The proposal carries no approver — issuing is a separate §28 act,
 * so a buyer can never both raise and approve their own order.
 */
export interface ProposePurchaseOrderPort {
  post(input: {
    readonly poId: string;
    readonly supplierId: string;
    readonly lines: readonly { readonly productId: string; readonly orderedQty: number; readonly unitCost: Money }[];
  }): Promise<ProposePurchaseOrderOutcome>;
}

export type CaptureRefusal =
  | 'file_has_problems'
  | 'does_not_add_up_to_the_invoice_total'
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

  /**
   * True when this box can reach head office to propose a PO. False offline / on a box the cloud port was
   * never wired into — the screen then keeps its local compute and does not offer to raise an order it
   * cannot actually send (P-01/P-08).
   */
  readonly canProposeToCloud: boolean;

  /**
   * PROPOSE a purchase order at head office (M06-FR-02). The requisitioner is the authenticated buyer; the
   * proposal carries NO approver — issuing is a SECOND person's act (§28), so a buyer can never both raise and
   * approve their own order from this screen. Reports `proposed: true` ONLY when the cloud saved it; a blocked
   * supplier, an empty order, or a dropped link is an honest `proposed: false` with the reason, never a false
   * "raised" (P-08). Proposing commits no money — only an issued PO becomes an open commitment.
   */
  proposeToCloud(input: ProposePurchaseOrderInput): Promise<ProposePurchaseOrderOutcome>;

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

  /**
   * Commit a previewed invoice — all of it or none of it — onto the DURABLE device queue (SP-7a · F02): the invoice is on
   * the device before this returns `ok`, the match on this very screen finds it at once, a second capture of it is
   * refused, and the shared device → box → cloud path carries it to head office. It is captured by the signed-in buyer
   * and carries NO checker: the check is a second person's own act at head office (the match, under their own sign-in).
   */
  captureInvoice(input: {
    readonly invoiceId: string;
    readonly supplierId: string;
    /** The purchase order the invoice is for, when the buyer knows it — head office matches against ITS copy. */
    readonly poId?: string | null;
    readonly preview: CapturePreview;
  }): CaptureOutcome;

  /** Compare the order, the delivery and the invoice (M07-FR-04). */
  match(input: { readonly poId: string; readonly invoiceId: string }): MatchResult;

  /** Every invoice this screen saved, newest first, each with where it has got to — from the durable queue, so the same after a reload. */
  savedInvoices(): readonly SavedInvoice[];
  /** The queue keys of invoices the store computer has taken, to ask it where they have got to. */
  handedKeys(): readonly string[];
  /** Fold in the store computer's word on items it took — "posted" is only ever its say-so. */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
}

/**
 * @param outbox the DURABLE device queue this screen's captures are written to (required, as on the manager screen and the
 *   handhelds — F02 was exactly the forgotten queue: `ok: true` returned and the invoice existed nowhere).
 */
export function createBuyingSession(config: BuyingConfig, ports: BuyingPorts, outbox: SyncOutbox): BuyingSession {
  const inr = (minor: number): Money => money(minor, config.currency);
  const now = config.now ?? (() => new Date().toISOString());
  /** The store computer's word on each queued invoice, keyed by queue key — filled by `noteBoxStatus`. */
  const boxWord = new Map<string, BoxItemStatus>();
  /** Invoices captured on THIS device and still on its queue — the plain boot's own memory (F02). */
  const queuedCaptures = (): readonly SupplierInvoiceCapturedPayload[] => outbox.all()
    .filter((item) => item.event.type === SUPPLIER_INVOICE_CAPTURED)
    .map((item) => item.event.payload as SupplierInvoiceCapturedPayload);
  /**
   * What is captured for an invoice: what the box last told this screen (the pack) — and, failing that, what this very
   * device queued. Before SP-7a only the first was read, so an invoice captured a moment ago was invisible to the match
   * and to the duplicate check on the same screen (F02).
   */
  const linesCaptured = (invoiceId: string): readonly InvoiceLine[] => {
    const known = ports.capturedLines(invoiceId);
    if (known.length > 0) return known;
    return queuedCaptures().filter((c) => c.invoiceId === invoiceId).flatMap((c) => c.lines);
  };

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

    canProposeToCloud: ports.proposeOrder !== undefined,

    proposeToCloud: async (input) => {
      const port = ports.proposeOrder;
      // No cloud wired: the screen keeps its local compute when `canProposeToCloud` is false; this guards
      // the case it asked anyway, and must never claim an order it did not send (P-01/P-08).
      if (port === undefined) {
        return { proposed: false, reason: 'this screen is not connected to head office, so it cannot raise an order' };
      }
      // Fail fast, before any POST, on what the screen already knows is wrong (P-08): an order with no lines
      // is not an order, and a buyer with no supplier chosen is not raising one. A clearer refusal here than
      // a 4xx the cloud would send back for the same thing.
      if (input.lines.length === 0) {
        return { proposed: false, reason: 'this order has no lines, so there is nothing to raise' };
      }
      if (input.supplierId.trim() === '') {
        return { proposed: false, reason: 'no supplier is chosen for this order' };
      }
      // The cloud is the authority — it attributes the requisitioner to the authenticated buyer and refuses a
      // blocked supplier. The proposal carries NO approver: issuing is a separate §28 act the buyer may not do,
      // and a dropped link or a refusal comes back as `proposed: false`, never a false "raised".
      return port().post({
        poId: input.poId,
        supplierId: input.supplierId,
        lines: input.lines.map((l) => ({ productId: l.productId, orderedQty: l.orderedQty, unitCost: inr(l.unitCostMinor) })),
      });
    },

    openCommitment: (input) => computeOpenCommitment(input),

    previewInvoice,

    captureInvoice: (input) => {
      if (linesCaptured(input.invoiceId).length > 0) {
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

      if (input.preview.lines.length === 0) {
        return {
          ok: false,
          refusal: 'nothing_to_capture',
          detail: 'there is nothing in this file to capture.',
        };
      }

      // Atomic by construction: the whole previewed line set goes into ONE queued event, written once — or, on any
      // refusal above, nothing is queued at all. Seventy-seven of eighty lines written is an invoice matching no piece
      // of paper anywhere, and nobody can say which three are missing.
      const captured: readonly InvoiceLine[] = Object.freeze([...input.preview.lines]);

      // QUEUED before it is called saved (F02 — before this, `ok: true` was returned and the invoice existed nowhere). The
      // outbox is the durable device queue `bootBuying` opens; enqueue writes it to the device before returning, and the
      // shared device → box → cloud path carries it from there. The key is the invoice's one identity at every hop.
      // Captured by the signed-in buyer; NO checker rides with it — the check is a second person's own act at head office.
      const capturedAt = now();
      const payload: SupplierInvoiceCapturedPayload = {
        invoiceId: input.invoiceId, supplierId: input.supplierId, poId: input.poId ?? null, lines: captured,
        declaredTotalMinor: input.preview.declaredTotalMinor, capturedBy: config.buyerId, capturedAt,
        storeId: config.storeId ?? null, source: 'buyer-screen',
      };
      outbox.enqueue(makeEvent({
        id: invoiceKeyFor(input.invoiceId),
        type: SUPPLIER_INVOICE_CAPTURED,
        occurredAt: capturedAt,
        idempotencyKey: invoiceKeyFor(input.invoiceId),
        source: 'web-erp/buying',
        payload,
      }));

      return {
        ok: true,
        invoiceId: input.invoiceId,
        lines: captured,
        totalMinor: input.preview.declaredTotalMinor,
      };
    },

    savedInvoices: () => outbox.all()
      .filter((item) => item.event.type === SUPPLIER_INVOICE_CAPTURED)
      .map((item): SavedInvoice => {
        const p = item.event.payload as SupplierInvoiceCapturedPayload;
        const box = boxWord.get(item.key);
        const reason = deviceItemReason(item, box);
        return {
          invoiceId: p.invoiceId, supplierId: p.supplierId, poId: p.poId, lineCount: p.lines.length, totalMinor: p.declaredTotalMinor,
          at: item.event.occurredAt, state: deviceItemState(item, box), attempts: item.attempts,
          ...(reason === undefined ? {} : { reason }),
        };
      })
      .reverse(),

    handedKeys: () => outbox.all().filter((item) => item.state === 'acknowledged').map((item) => item.key),

    noteBoxStatus: (statuses) => {
      for (const st of statuses) boxWord.set(st.key, st);
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
      const invoiced = linesCaptured(input.invoiceId);

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
