// The cloud-side return guard (M13-FR-01/FR-03, M21) — **the consumer that finally feeds the
// register.**
//
// `packages/returns/return-register.ts` was written to answer one question — *how much of this bill
// has already come back?* — and its own header records that outside a unit test nothing ever asked
// it. The offline till commits a return against its own log; but the box only knows its own log, so
// the same receipt refunded at one lane, then at another, then online, passes three times, each
// against a register that was never told about the other two. The authoritative guard has to sit
// where the whole history is, and that is the cloud.
//
// This is that guard, and it is pure: given the original bill, everything already returned and
// refunded against it, and a new return, it says *yes and here is what is left*, or *no and exactly
// why*. It commits nothing — the service appends the event and the ledger keeps the truth. It lives
// in the package, not the service, for the same reason the three-way match does: the desk's own
// screen must be able to run the identical rule, and a browser cannot import the HTTP kernel.
//
// Three M13 rules, enforced here against the full history rather than one box's slice of it:
//   • a product is returned at most once — cumulative return may never exceed what was sold
//     (M13-FR-01), so there is no double refund of goods;
//   • a refund can never take the total refunded above what the bill was paid (M13-FR-03);
//   • a material refund needs a second, different person (M13-FR-03 / §28).
// A card/UPI refund is reported PENDING, never assumed settled (M13-FR-04) — the mirror of the
// no-invented-approval rule.

import type { Disposition, RefundStatus } from './returns';
import {
  returnRegister, returnableLines, alreadyRefundedMinor,
  type OriginalSale, type RecordedReturn, type ReturnableLine,
} from './return-register';

/** Cash and store credit settle at the desk; a card/UPI reversal is a provider round-trip. */
const OFFLINE_SETTLED_TENDERS: readonly string[] = ['cash', 'store_credit'];
const DISPOSITIONS: ReadonlySet<Disposition> = new Set<Disposition>(['resell', 'quarantine', 'damaged', 'scrap']);

export interface ReturnRequestLine {
  readonly productId: string;
  readonly uom: string;
  /** Quantity coming back now, in the UOM's smallest unit. Magnitude, always > 0. */
  readonly quantityMinor: number;
  readonly disposition: Disposition;
}

export interface ReturnRequest {
  readonly returnId: string;
  readonly number: string;
  readonly originalSaleId: string;
  readonly processedBy: string;
  readonly processedAt: string;
  readonly reasonCode: string;
  readonly lines: readonly ReturnRequestLine[];
  /** The money handed back to the customer, in minor units. */
  readonly refundMinor: number;
  /** How it is handed back — drives the settled/pending distinction (M13-FR-04). */
  readonly refundTender: string;
  /** Refund value at/above which a separate approver is required (per-tenant, §28). */
  readonly approvalThresholdMinor: number;
  /** The second person who approved a material refund. Must differ from `processedBy` (§28). */
  readonly approvedBy?: string;
}

export type ReturnRefusal =
  | 'no_lines'
  | 'no_reason'
  | 'line_not_readable'
  | 'product_not_on_this_bill'
  | 'more_than_was_sold'
  | 'refund_exceeds_what_is_left'
  | 'needs_a_second_person'
  | 'approved_by_the_person_processing_it';

export interface ReturnAssessment {
  readonly ok: boolean;
  readonly refusedBecause?: ReturnRefusal;
  readonly detail: string;
  /** Cash/store-credit → settled at the desk; card/UPI → a pending reversal (M13-FR-04). */
  readonly refundStatus: RefundStatus;
  /** How many of this return's lines re-enter sellable stock (disposition `resell`). */
  readonly restockedLines: number;
  /** What is still returnable on this bill AFTER this return, for the desk to show at once. */
  readonly remaining: readonly ReturnableLine[];
}

/**
 * Assess one return against a bill and everything already returned/refunded against it.
 *
 * The one subtlety worth stating: a return does **not** count against itself. The prior history is
 * filtered by `returnId` before the register is built, so re-sending the same return — a till
 * retrying what it could not confirm — is assessed as if it had not happened yet and reaches the
 * same answer, rather than being refused as a double of its own first attempt. The service's append
 * is idempotent on the same id, so the retry writes nothing new.
 */
export function assessReturn(input: {
  readonly sale: OriginalSale;
  readonly priorReturns: readonly RecordedReturn[];
  readonly priorRefunds: readonly { readonly returnId: string; readonly originalSaleId: string | null; readonly refundMinor: number }[];
  readonly request: ReturnRequest;
}): ReturnAssessment {
  const { sale, request } = input;

  // This return does not count against itself (idempotent retry — see the note above).
  const priorReturns = input.priorReturns.filter((r) => r.returnId !== request.returnId);
  const priorRefunds = input.priorRefunds.filter((r) => r.returnId !== request.returnId);

  const refundStatus: RefundStatus = OFFLINE_SETTLED_TENDERS.includes(request.refundTender) ? 'settled' : 'pending';

  const returnableNow = returnableLines(sale, returnRegister(priorReturns));
  const returnableByProduct = new Map(returnableNow.map((l) => [l.productId, l]));

  const refuse = (refusedBecause: ReturnRefusal, detail: string): ReturnAssessment => ({
    ok: false, refusedBecause, detail, refundStatus, restockedLines: 0, remaining: returnableNow,
  });

  if (request.lines.length === 0) {
    return refuse('no_lines', `return ${request.returnId} has no lines, so there is nothing to take back`);
  }
  if (request.reasonCode.trim() === '') {
    return refuse('no_reason', `return ${request.returnId} carries no reason code, so "why did this come back" cannot be answered later`);
  }
  for (const line of request.lines) {
    if (typeof line.productId !== 'string' || line.productId.trim() === ''
      || !Number.isInteger(line.quantityMinor) || line.quantityMinor <= 0
      || !DISPOSITIONS.has(line.disposition)) {
      return refuse('line_not_readable', 'every return line needs a product, a positive whole quantity, and a disposition (resell, quarantine, damaged or scrap)');
    }
  }

  // At-most-once per product, against the WHOLE bill and the WHOLE history (M13-FR-01). The request
  // is aggregated by product first, so two lines of the same product cannot each pass half the
  // remaining and breach the cap together — the same reason the register aggregates by product.
  const requestedByProduct = new Map<string, number>();
  for (const line of request.lines) {
    requestedByProduct.set(line.productId, (requestedByProduct.get(line.productId) ?? 0) + line.quantityMinor);
  }
  for (const [productId, wanted] of requestedByProduct) {
    const returnable = returnableByProduct.get(productId);
    if (returnable === undefined) {
      return refuse('product_not_on_this_bill', `${productId} was not sold on bill ${sale.number}; a return is against what the bill says was bought`);
    }
    if (wanted > returnable.returnableMinor) {
      return refuse('more_than_was_sold', `${productId}: ${wanted} asked back, but only ${returnable.returnableMinor} of the ${returnable.soldMinor} sold is left to return (${returnable.alreadyReturnedMinor} already came back)`);
    }
  }

  // The money never goes out twice: a refund cannot take the total refunded above what was paid
  // (M13-FR-03). Checked before the approver test, so an impossible refund is named as such rather
  // than as merely unapproved.
  const alreadyRefunded = alreadyRefundedMinor(sale.saleId, priorRefunds);
  if (request.refundMinor < 0 || alreadyRefunded + request.refundMinor > sale.totalMinor) {
    return refuse('refund_exceeds_what_is_left', `refund ${request.refundMinor} would take the total refunded on bill ${sale.number} to ${alreadyRefunded + request.refundMinor}, above the ${sale.totalMinor} that was paid`);
  }

  // A material refund needs a second, different person (M13-FR-03 / §28).
  const material = request.refundMinor > 0 && request.refundMinor >= request.approvalThresholdMinor;
  if (material) {
    if (request.approvedBy === undefined || request.approvedBy.trim() === '') {
      return refuse('needs_a_second_person', `a refund of ${request.refundMinor} is at or above the ${request.approvalThresholdMinor} threshold and needs a second person to approve it`);
    }
    if (request.approvedBy === request.processedBy) {
      return refuse('approved_by_the_person_processing_it', `${request.processedBy} cannot both process and approve their own refund`);
    }
  }

  // Approved. What is left after this return, so the desk sees it in the same round-trip.
  const remaining = returnableNow.map((l): ReturnableLine => {
    const taken = requestedByProduct.get(l.productId) ?? 0;
    return { ...l, alreadyReturnedMinor: l.alreadyReturnedMinor + taken, returnableMinor: Math.max(0, l.returnableMinor - taken) };
  });
  const restockedLines = request.lines.filter((l) => l.disposition === 'resell').length;

  return {
    ok: true,
    detail: `return ${request.returnId} accepted against bill ${sale.number}: ${request.refundMinor} refunded by ${request.refundTender} (${refundStatus})`,
    refundStatus, restockedLines, remaining,
  };
}
