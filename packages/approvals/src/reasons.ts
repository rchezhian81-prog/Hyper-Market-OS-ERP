// The decision vocabulary (M02 / §28 audit) — the fixed set of reasons a request may be approved
// or rejected with, shared by every surface that can decide one.
//
// ── Why this is a package and not a screen's private list ────────────────────
//
// A reason is mandatory on every decision and it lands in the audit trail forever. If the store
// manager's screen and the owner's phone each carried their own list, the trail would fill up with
// two vocabularies for one question, and the report that asks *"how many price changes did we
// approve because the owner told us to?"* would be answerable on one surface and not the other.
// One list, in the package that records the decision.
//
// ── Why they are codes, and why the two lists do not overlap ─────────────────
//
// **Codes, because free text at a screen is a reason nobody can report on afterwards.** "ok fine"
// looks like a considered decision in a table a year later and means nothing.
//
// **Two lists, because approving something "against policy" is not a decision anybody should be
// able to record**, and rejecting something as "within policy" is not a sentence that means
// anything. Offering one list for both would let either be written down, where it would sit
// looking deliberate forever.
//
// The WORDS for each code live in the screens, in every language that screen offers. The code is
// what crosses the boundary; the sentence is a rendering of it.

import type { Decision } from './approvals';

/** Why a request may be approved. */
export const APPROVE_REASONS = Object.freeze([
  'within_policy',
  'checked_with_supplier',
  'checked_the_stock',
  'owner_instructed',
] as const);

/** Why a request may be rejected. */
export const REJECT_REASONS = Object.freeze([
  'price_looks_wrong',
  'not_enough_evidence',
  'against_policy',
  'ask_the_owner_first',
] as const);

export type ApproveReason = (typeof APPROVE_REASONS)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];
export type DecisionReasonCode = ApproveReason | RejectReason;

/** The reasons a surface may offer for this decision — and only these. */
export function reasonsFor(decision: Decision): readonly DecisionReasonCode[] {
  return decision === 'approved' ? APPROVE_REASONS : REJECT_REASONS;
}

/**
 * Whether a code may be recorded against this decision.
 *
 * Checked by a surface **before** the engine, so an invented or mismatched reason is refused
 * rather than written down. There is no repairing an audit trail afterwards.
 */
export function isValidReasonFor(decision: Decision, code: string): code is DecisionReasonCode {
  return (reasonsFor(decision) as readonly string[]).includes(code);
}
