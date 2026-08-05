// API-03 Purchase — suppliers, POs, GRNs, invoices, three-way match.
//
// The single most valuable control on this surface is not about purchasing at all: **a change to a
// supplier's bank details is verified out of band, against a number the supplier gave us before
// the request arrived** (M06, `packages/bank-controls`). Invoice fraud in retail is almost never
// clever — it is an email from a real supplier's real address saying the account has changed, and
// the money leaves on the next payment run. A system that accepts the change because the email
// looked right has no control at all.
//
// The second is the **three-way match**: a PO, a receipt and an invoice must agree before anything
// is paid, and where they do not, what is paid is the *lowest* of the three until a person settles
// it. Paying the invoice and investigating later is how an overcharge becomes permanent.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export interface MatchLine {
  readonly productId: string;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly invoicedQty: number;
  readonly orderedUnitMinor: number;
  readonly invoicedUnitMinor: number;
}

export type MatchStatus = 'matched' | 'within_tolerance' | 'blocked';

export interface LineMatch {
  readonly productId: string;
  readonly status: MatchStatus;
  readonly quantityDifference: number;
  readonly priceDifferenceMinor: number;
  /** What may be paid now: never more than the lowest of the three. */
  readonly payableMinor: number;
  readonly detail: string;
}

export interface MatchResult {
  readonly lines: readonly LineMatch[];
  readonly payableMinor: number;
  readonly invoicedMinor: number;
  readonly withheldMinor: number;
  readonly blocked: boolean;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * Match a PO, a receipt and an invoice.
 *
 * Where they disagree the payable is the **lowest** of what was ordered, received and invoiced,
 * at the **lower** of the ordered and invoiced price. Paying the invoice and investigating
 * afterwards is how an overcharge becomes permanent — the supplier has the money and the
 * conversation is now about a refund.
 */
export function threeWayMatch(input: {
  readonly lines: readonly MatchLine[];
  /** Quantity tolerance in basis points. Per-tenant (OC-13). Default 0. */
  readonly quantityToleranceBps?: number;
  /** Price tolerance in basis points. Per-tenant. Default 100 (1%). */
  readonly priceToleranceBps?: number;
  /** Value below which a difference is not worth a person's time. Default ₹1. */
  readonly immaterialMinor?: number;
}): MatchResult {
  const qTol = input.quantityToleranceBps ?? 0;
  const pTol = input.priceToleranceBps ?? 100;
  const immaterial = input.immaterialMinor ?? 100;

  // No lines is not a match.
  //
  // Everything below is `map`, `reduce` and `some` over the line set, and all three are perfectly
  // happy with an empty one: an invoice we hold no lines for returned `blocked: false`, "invoiced
  // 0, matched", and told the owner "nothing — the order, the delivery and the invoice agree".
  // Three documents cannot agree when we are holding none of them. The distinction is between
  // *checked and clean* and *not checked*, and only one of those is a reason to pay.
  if (input.lines.length === 0) {
    return {
      lines: [], payableMinor: 0, invoicedMinor: 0, withheldMinor: 0, blocked: true,
      detail: 'no lines were found for this invoice, so nothing has been compared',
      ownerAction: 'Nothing may be paid on this invoice yet — not because a difference was found, but because no order, delivery or invoice line was found to compare. Check the invoice was received and its lines were captured, then match it again.',
    };
  }

  const lines = input.lines.map((l): LineMatch => {
    const payQty = Math.min(l.orderedQty, l.receivedQty, l.invoicedQty);
    const payUnit = Math.min(l.orderedUnitMinor, l.invoicedUnitMinor);
    const payableMinor = payQty * payUnit;

    const quantityDifference = l.invoicedQty - l.receivedQty;
    const priceDifferenceMinor = l.invoicedUnitMinor - l.orderedUnitMinor;

    const qOut = l.orderedQty === 0 ? quantityDifference !== 0
      : Math.abs(quantityDifference * 10_000 / l.orderedQty) > qTol;
    const pOut = l.orderedUnitMinor === 0 ? priceDifferenceMinor !== 0
      : Math.abs(priceDifferenceMinor * 10_000 / l.orderedUnitMinor) > pTol;
    const value = Math.abs(l.invoicedQty * l.invoicedUnitMinor - payableMinor);

    const status: MatchStatus = !qOut && !pOut ? 'matched'
      : value <= immaterial ? 'within_tolerance' : 'blocked';

    return {
      productId: l.productId, status, quantityDifference, priceDifferenceMinor, payableMinor,
      detail: status === 'matched' ? `${l.productId}: agrees at ${payableMinor}`
        : status === 'within_tolerance' ? `${l.productId}: differs by ${value}, inside tolerance`
          : `${l.productId}: invoiced ${l.invoicedQty} at ${l.invoicedUnitMinor}, received ${l.receivedQty}, ordered ${l.orderedQty} at ${l.orderedUnitMinor}. Paying the lower of each: ${payableMinor}`,
    };
  });

  const payableMinor = lines.reduce((t, l) => t + l.payableMinor, 0);
  const invoicedMinor = input.lines.reduce((t, l) => t + l.invoicedQty * l.invoicedUnitMinor, 0);
  const blocked = lines.some((l) => l.status === 'blocked');

  return {
    lines, payableMinor, invoicedMinor, withheldMinor: invoicedMinor - payableMinor, blocked,
    detail: blocked
      ? `invoiced ${invoicedMinor}, payable ${payableMinor}, ${invoicedMinor - payableMinor} withheld`
      : `invoiced ${invoicedMinor}, matched`,
    ownerAction: blocked
      ? `${invoicedMinor - payableMinor} is held back until the differences are settled. The supplier is paid what all three documents agree on — releasing the rest first turns an overcharge into a refund conversation`
      : 'nothing — the order, the delivery and the invoice agree',
  };
}

export interface BankChangeRequest {
  readonly supplierId: string;
  readonly newAccount: string;
  readonly requestedVia: 'email' | 'letter' | 'portal' | 'phone_call_we_made';
  /** Confirmed on a number we already held, not one supplied with the request. */
  readonly calledBackOn?: string;
  readonly numberWeAlreadyHeld?: string;
  readonly approvedBy?: string;
  readonly requestedBy: string;
  /**
   * When the request arrived. Required, and it is evidence rather than bookkeeping.
   *
   * "When did this come in?" is the first question at an investigation into a payment that went
   * to the wrong place, and it is also what keeps the record straight when a supplier moves to a
   * new account and later moves back: without a date, the return to the first account looks
   * identical to the original change and collapses into it — leaving the ledger asserting the
   * money still goes to the middle account.
   */
  readonly requestedAt: string;
}

export type BankChangeRefusal =
  | 'no_request_date'
  | 'not_called_back'
  | 'called_back_on_the_number_they_supplied'
  | 'not_approved'
  | 'approved_by_the_requester';

export interface BankChangeResult {
  readonly ok: boolean;
  readonly refusedBecause?: BankChangeRefusal;
  readonly detail: string;
}

/**
 * Verify a supplier bank-detail change.
 *
 * The refusal that matters is the second one. Ringing the number printed on the letter that asks
 * for the change reaches whoever sent the letter — it feels like verification and confirms
 * nothing. The call must go to a number we already held.
 */
export function verifyBankChange(r: BankChangeRequest): BankChangeResult {
  if (typeof r.requestedAt !== 'string' || Number.isNaN(Date.parse(r.requestedAt))) {
    return {
      ok: false, refusedBecause: 'no_request_date',
      detail: `${r.supplierId}'s account change carries no date it was requested on. An undated request cannot be placed against the call that verified it or the payment run that followed, which is the whole sequence an investigation reads`,
    };
  }
  if (r.calledBackOn === undefined) {
    return {
      ok: false, refusedBecause: 'not_called_back',
      detail: `${r.supplierId}'s account change arrived by ${r.requestedVia} and nobody rang them. Invoice fraud in retail is not clever — it is a real supplier's real address saying the account has changed, and the money leaves on the next payment run`,
    };
  }
  if (r.numberWeAlreadyHeld === undefined || r.calledBackOn !== r.numberWeAlreadyHeld) {
    return {
      ok: false, refusedBecause: 'called_back_on_the_number_they_supplied',
      detail: `the call went to ${r.calledBackOn}, which is not the number we already held. Ringing the number on the letter that asks for the change reaches whoever sent the letter — it feels like verification and confirms nothing`,
    };
  }
  if (r.approvedBy === undefined) {
    return { ok: false, refusedBecause: 'not_approved', detail: 'a bank-detail change needs a second person' };
  }
  if (r.approvedBy === r.requestedBy) {
    return { ok: false, refusedBecause: 'approved_by_the_requester', detail: `${r.requestedBy} approved their own bank change for ${r.supplierId}` };
  }
  return { ok: true, detail: `${r.supplierId} verified on ${r.numberWeAlreadyHeld}, approved by ${r.approvedBy}` };
}

export interface PurchaseDeps {
  readonly matchLines: (tenantId: string, invoiceId: string) => Promise<readonly MatchLine[]> | readonly MatchLine[];
  readonly recordMatch: (tenantId: string, invoiceId: string, r: MatchResult) => Promise<void> | void;
  readonly applyBankChange: (tenantId: string, r: BankChangeRequest) => Promise<void> | void;
  /**
   * What is on order and not yet received.
   *
   * **`undefined` means not known, and that is not the same answer as zero.** Purchase orders are
   * not yet recorded by this API, so a projection over an empty stream would return
   * `{count: 0, valueMinor: 0}` — which an owner reads as "we have nothing on order" and uses to
   * decide what to buy. Not-known is returned as not-known, the same way loyalty points are.
   */
  readonly openCommitments: (tenantId: string) => Promise<Commitments | undefined> | Commitments | undefined;
  readonly now: () => string;
}

export interface Commitments {
  readonly count: number;
  readonly valueMinor: number;
}

export function purchaseRoutes(deps: PurchaseDeps): readonly Route[] {
  return [
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/match',
      permission: 'purchase.invoice.match', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const result = threeWayMatch({ lines: await deps.matchLines(ctx.tenantId, invoiceId) });
        await deps.recordMatch(ctx.tenantId, invoiceId, result);
        return { status: 200, body: result };
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/bank-details',
      permission: 'purchase.supplier.bank', idempotent: true,
      handler: async (ctx) => {
        const request = { ...(ctx.body as BankChangeRequest), supplierId: ctx.params['supplierId'] ?? '' };
        const check = verifyBankChange(request);
        if (!check.ok) {
          throw apiError(422, {
            code: check.refusedBecause!,
            whatHappened: check.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The old account is unchanged and payments will still go there. Ring the supplier on a number you already had, then have a second person approve it.',
          });
        }
        await deps.applyBankChange(ctx.tenantId, request);
        return { status: 200, body: { changed: check.detail } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/commitments',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const open = await deps.openCommitments(ctx.tenantId);
        return {
          status: 200,
          body: open === undefined
            ? {
              known: false, asAt: deps.now(),
              detail: 'what is on order cannot be stated yet, because purchase orders are not recorded in this system. A zero here would read as "we have nothing on order" and be acted on.',
            }
            : { ...open, known: true, asAt: deps.now() },
        };
      },
    },
  ];
}
