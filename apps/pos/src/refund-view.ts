// Refund view surface — the tested bridge between the cashier's refund screen and the refund engine.
//
// This is to a refund what `view-adapter.ts` is to a sale: a thin, tested layer that deals ONLY in
// display primitives (integer minor units, plain strings) and holds NO money rule of its own. Every
// rule — at-most-once per line, refund never exceeding what was paid, the §28 approver, the card/UPI
// pending distinction — stays in the tested engine (`packages/returns`) and in `till.refund`. This
// surface converts the cashier's choices into the engine's typed input, and converts the engine's
// outcomes and its four money-critical error types into ONE plain-English screen state the web UI
// (and its guardrail) can rely on. Nothing here is a second, untested copy of a critical message.
//
// **The numbers are injected, never invented.** The return window, the no-receipt cap and the
// approval threshold are owner-input-pending (docs/requirements/M13.md); the screen receives them as
// policy from the edge read model exactly as the engine receives them as inputs. Absent a configured
// no-receipt cap, the no-receipt path is UNAVAILABLE (fail safe) rather than defaulted to a guess.

import { money, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { TenderKind } from '../../../packages/contracts/src/enums';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import {
  returnRegister, returnableLines, alreadyRefundedMinor,
  type OriginalSale, type ReturnableLine, type RecordedReturn,
} from '../../../packages/returns/src/return-register';
import {
  refundRequiresApproval, type CommitReturnInput, type CommittedReturn, type Disposition,
  EmptyReturnError, MissingReasonError, MissingOriginalSaleError,
  InvalidReturnQuantityError, OverReturnError, ExcessRefundError, ApprovalRequiredError,
} from '../../../packages/returns/src/returns';
import {
  LocalRefundRefusedError, RefundConflictError, RefundNotEntitledError, RefundUncertainError,
} from './till-session';

/** A prior refund's value against a bill, so a second refund cannot exceed what is left (M13-FR-03). */
export interface PriorRefund {
  readonly returnId: string;
  readonly originalSaleId: string | null;
  readonly refundMinor: number;
}

/** The per-tenant policy the screen is GIVEN (never invents). Threshold defaults to 0 → every
 * positive refund needs a §28 approver; a no-receipt cap must be supplied or the no-receipt path is
 * unavailable. The return window is deliberately absent here — it is not enforced in this slice. */
export interface RefundPolicy {
  readonly approvalThresholdMinor: number;
  readonly noReceiptCapMinor?: number;
  readonly currency?: CurrencyCode;
}

/** One line the cashier has chosen to return, in display primitives. */
export interface RefundLineChoice {
  readonly productId: string;
  readonly uom: string;
  /** How many to return now, in the UOM's smallest unit (> 0). */
  readonly quantityMinor: number;
  readonly disposition: Disposition;
}

/** A refund as the screen has assembled it, before it is submitted. */
export interface RefundDraft {
  /** The refund's operation identity, minted at the lane (idempotent retry key — RR-F03). */
  readonly returnId: string;
  /** The refund document's own number (from the lane's reserved range). */
  readonly number: string;
  /** The looked-up original bill; omit for a no-receipt return. */
  readonly originalSale?: OriginalSale;
  readonly noReceipt?: boolean;
  readonly reasonCode: string;
  readonly lines: readonly RefundLineChoice[];
  /** The amount to give back, in minor units. Shown, not typed beyond the cap the screen enforces. */
  readonly refundMinor: number;
  readonly refundTender: TenderKind;
  /** A manager's decision, when the refund requires one (§28). */
  readonly approval?: DecidedRequest;
}

/**
 * The one screen state every refund resolves to. `settled`/`pending` carry the money and the
 * document number; the rest carry only the plain-English `laneMessage` a cashier acts on. The
 * money-critical four (`refused`/`uncertain`/`conflict`/`not_entitled`) are distinct on purpose:
 * confusing "a reply was lost" with "it failed" is what causes a second refund (RR-F02).
 */
export type RefundScreenOutcome =
  | { readonly kind: 'settled'; readonly refundMinor: number; readonly number: string; readonly laneMessage: string }
  | { readonly kind: 'pending'; readonly refundMinor: number; readonly number: string; readonly laneMessage: string }
  | { readonly kind: 'refused'; readonly laneMessage: string }
  | { readonly kind: 'uncertain'; readonly laneMessage: string }
  | { readonly kind: 'conflict'; readonly laneMessage: string }
  | { readonly kind: 'not_entitled'; readonly laneMessage: string }
  | { readonly kind: 'approval_required'; readonly laneMessage: string }
  | { readonly kind: 'invalid'; readonly laneMessage: string };

/** The refund call this surface drives — `till.refund` (or a test stand-in). */
export type RefundCall = (input: Omit<CommitReturnInput, 'laneId' | 'processedBy'>) => Promise<CommittedReturn>;

export interface RefundViewDeps {
  /** The till's durable-first refund. Money leaves the drawer only after the edge confirms. */
  readonly refund: RefundCall;
  /** ISO-8601 UTC clock, injected so the surface is deterministic under test. */
  readonly now: () => string;
  /** The per-tenant caps/threshold, from the edge read model. Never invented here. */
  readonly policy: RefundPolicy;
  /** Prior returns (this box's log + cloud history), for the returnable-per-line display. */
  readonly priorReturns?: readonly RecordedReturn[];
  /** Prior refunds against the bill, for the money-left display and the max-refund ceiling. */
  readonly priorRefunds?: readonly PriorRefund[];
}

/** The tested surface the refund screen binds to. */
export interface RefundView {
  /** What may still be returned on a bill, per product — for the screen to cap the stepper. */
  returnable(sale: OriginalSale): readonly ReturnableLine[];
  /** The most this bill may still refund (paid − already refunded), in minor units. */
  maxRefundMinor(sale: OriginalSale): number;
  /** Whether this draft needs a §28 approver — so the screen asks for a manager BEFORE submitting. */
  needsApproval(draft: RefundDraft): boolean;
  /** Assemble, submit and resolve a refund to exactly one screen state. Never throws. */
  submit(draft: RefundDraft): Promise<RefundScreenOutcome>;
}

// The plain-English messages for outcomes the ENGINE raises as plain validation errors (before any
// durable write). The money-critical durable outcomes carry the model's OWN `laneMessage` and are
// never reworded here — that message is written for a cashier with a customer watching, and a second
// copy of it would be a second, untested version of the most important sentence in the product.
const MSG = {
  approvalRequired: 'This refund needs a manager to approve it. Ask a manager (not yourself) to approve, then try again.',
  overReturned: 'These goods were already returned on this bill. Nothing more can come back — do not pay out.',
  excess: 'This refund is more than this bill allows. Check the amount before paying out.',
  noLines: 'Add at least one item to return.',
  noReason: 'Choose a reason for the return.',
  noOriginal: 'This refund needs the original bill, or mark it as a no-receipt return.',
  badQuantity: 'Each returned item needs a quantity greater than zero.',
  noReceiptUnavailable: 'No-receipt refunds are not set up on this lane. Get the manager.',
} as const;

export function createRefundView(deps: RefundViewDeps): RefundView {
  const currency: CurrencyCode = deps.policy.currency ?? 'INR';
  const register = () => returnRegister(deps.priorReturns ?? []);

  const returnable = (sale: OriginalSale): readonly ReturnableLine[] => returnableLines(sale, register());

  const maxRefundMinor = (sale: OriginalSale): number => Math.max(
    0, sale.totalMinor - alreadyRefundedMinor(sale.saleId, deps.priorRefunds ?? []),
  );

  const needsApproval = (draft: RefundDraft): boolean => refundRequiresApproval(
    draft.refundMinor, draft.noReceipt ?? false, deps.policy.approvalThresholdMinor,
  );

  const submit = async (draft: RefundDraft): Promise<RefundScreenOutcome> => {
    const noReceipt = draft.noReceipt ?? false;

    // No-receipt with no configured cap is refused up front — the cap is a control we were not given,
    // and inventing one would be inventing a policy number (M13-FR-01). Fail safe, do not pay out.
    if (noReceipt && deps.policy.noReceiptCapMinor === undefined) {
      return { kind: 'invalid', laneMessage: MSG.noReceiptUnavailable };
    }

    // Trusted line facts come from the bill + return history, never from what the screen supplies:
    // how much of each product was sold, and how much has already come back (the RR-F04 principle at
    // the view boundary). For a no-receipt return there is no bill to check against.
    const returnableByProduct = new Map(
      draft.originalSale === undefined ? [] : returnable(draft.originalSale).map((l) => [l.productId, l] as const),
    );
    const lines = draft.lines.map((choice) => {
      const known = returnableByProduct.get(choice.productId);
      return {
        productId: choice.productId,
        uom: choice.uom,
        quantityMinor: choice.quantityMinor,
        // For a receipted return these come from the bill; for no-receipt the engine skips the sold
        // check, so the choice's own quantity is a harmless stand-in.
        originalQtyMinor: known?.soldMinor ?? choice.quantityMinor,
        alreadyReturnedMinor: known?.alreadyReturnedMinor ?? 0,
        disposition: choice.disposition,
      };
    });

    // The money ceiling: a receipted refund cannot exceed what is left of what was paid; a no-receipt
    // refund is bounded by its cap (the engine also checks the cap separately).
    const maxRefundValue = noReceipt
      ? deps.policy.noReceiptCapMinor ?? 0
      : draft.originalSale === undefined ? 0 : maxRefundMinor(draft.originalSale);

    const input: Omit<CommitReturnInput, 'laneId' | 'processedBy'> = {
      id: draft.returnId,
      number: draft.number,
      originalSaleId: noReceipt ? null : draft.originalSale?.saleId ?? null,
      noReceipt,
      processedAt: deps.now(),
      reasonCode: draft.reasonCode,
      lines,
      refund: money(draft.refundMinor, currency),
      refundTender: draft.refundTender,
      maxRefund: money(maxRefundValue, currency),
      approvalThresholdMinor: deps.policy.approvalThresholdMinor,
      ...(deps.policy.noReceiptCapMinor === undefined ? {} : { noReceiptCapMinor: deps.policy.noReceiptCapMinor }),
      ...(draft.approval === undefined ? {} : { approval: draft.approval }),
    };

    try {
      const committed = await deps.refund(input);
      // Cash/store credit settled at the lane → hand it over. Card/UPI is a reversal the provider has
      // not performed → pending, and the customer is told that, not shown a completed refund (M13-FR-04).
      if (committed.refundStatus === 'pending') {
        return {
          kind: 'pending', refundMinor: committed.refund.minor, number: committed.number,
          laneMessage: 'Refund sent for reversal. It is PENDING — do not hand over cash; the money returns to the card/UPI.',
        };
      }
      return {
        kind: 'settled', refundMinor: committed.refund.minor, number: committed.number,
        laneMessage: 'Refund recorded. Hand over the refund.',
      };
    } catch (e) {
      return mapError(e);
    }
  };

  return { returnable, maxRefundMinor, needsApproval, submit };
}

/**
 * Map every way a refund can be refused to its screen state. The four durable outcomes keep the
 * edge's own words; the engine's pre-write validation errors get the tested plain-English set above.
 * Anything unrecognised is treated as a refusal — the safe direction for money out (do not pay).
 */
function mapError(e: unknown): RefundScreenOutcome {
  // Durable, money-critical — the model's own words, never reworded.
  if (e instanceof RefundUncertainError) return { kind: 'uncertain', laneMessage: e.laneMessage };
  if (e instanceof RefundConflictError) return { kind: 'conflict', laneMessage: e.laneMessage };
  if (e instanceof RefundNotEntitledError) return { kind: 'not_entitled', laneMessage: e.laneMessage };
  if (e instanceof LocalRefundRefusedError) return { kind: 'refused', laneMessage: e.laneMessage };

  // Pre-write validation (assertReturnValid) — refused before anything was written.
  if (e instanceof ApprovalRequiredError) return { kind: 'approval_required', laneMessage: MSG.approvalRequired };
  if (e instanceof OverReturnError) return { kind: 'not_entitled', laneMessage: MSG.overReturned };
  if (e instanceof ExcessRefundError) return { kind: 'invalid', laneMessage: MSG.excess };
  if (e instanceof EmptyReturnError) return { kind: 'invalid', laneMessage: MSG.noLines };
  if (e instanceof MissingReasonError) return { kind: 'invalid', laneMessage: MSG.noReason };
  if (e instanceof MissingOriginalSaleError) return { kind: 'invalid', laneMessage: MSG.noOriginal };
  if (e instanceof InvalidReturnQuantityError) return { kind: 'invalid', laneMessage: MSG.badQuantity };

  // Unknown — do not pay out. A refusal is the safe reading of anything we did not expect.
  return { kind: 'refused', laneMessage: 'This refund could not be completed. Do not hand over cash — tell the manager.' };
}
