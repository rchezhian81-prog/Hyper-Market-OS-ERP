// The cash-office sign-off on a material over/short (M14 cash office, P-03 control by exception).
//
// A blind count that comes up short beyond tolerance is recorded and listed — but a shortage that is
// only ever *listed* is a shortage nobody worked. Control by exception (P-03) means the exception must
// be picked up, explained and closed by someone accountable, not left glowing on a screen. This is the
// rule that governs that sign-off. It commits nothing — the service records the review append-only.
//
// The one rule that makes it worth anything is separation of duties: the person who counted the drawer
// cannot be the person who clears its shortage. A cashier who can sign off their own till short is not
// a control; it is the absence of one.
//
// Pure and deterministic: no clock, no I/O.

export interface OverShortReviewInput {
  /** The authenticated reviewer (the cash office / store manager) — never taken from the request body. */
  readonly reviewerId: string;
  /** The cashier who closed the shift, from the recorded close. */
  readonly cashierId: string;
  /** Whether the close raised a material over/short. Only a material variance is reviewable. */
  readonly exceptionRaised: boolean;
  /** The reviewer's coded finding for why the drawer was over/short — required, never blank. */
  readonly disposition: string;
}

export type OverShortReviewRefusal =
  | 'nothing_to_review'
  | 'cannot_review_your_own_drawer'
  | 'disposition_required';

export interface OverShortReviewAssessment {
  readonly ok: boolean;
  readonly refusedBecause?: OverShortReviewRefusal;
  readonly detail: string;
}

/**
 * Assess whether a cash-office sign-off on an over/short may be recorded. A clean drawer has nothing to
 * review; a cashier may not clear their own till; and a sign-off with no stated finding is not a review.
 */
export function assessOverShortReview(input: OverShortReviewInput): OverShortReviewAssessment {
  if (!input.exceptionRaised) {
    return {
      ok: false,
      refusedBecause: 'nothing_to_review',
      detail: 'the drawer balanced within tolerance at close — there is no over/short to sign off',
    };
  }
  if (input.reviewerId === input.cashierId) {
    return {
      ok: false,
      refusedBecause: 'cannot_review_your_own_drawer',
      detail: 'the cashier who counted the drawer cannot sign off its own over/short — the review needs a second, accountable person',
    };
  }
  if (input.disposition.trim() === '') {
    return {
      ok: false,
      refusedBecause: 'disposition_required',
      detail: 'a sign-off must state a finding for why the drawer was over/short — a blank sign-off closes nothing',
    };
  }
  return { ok: true, detail: 'the over/short may be signed off by this reviewer' };
}
