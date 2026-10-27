// SUPPLIER REBATE CLAIMS (D03-FR-03 "accrue rebate/funding claims" · M06-FR-03 · §28 "Finance approves rebate claims" ·
// OB-404, owner, 27 Oct 2026, option A). Pure and deterministic — the rule the claim routes run on.
//
// A rebate is ACCRUED from the supplier's matched bills (`accrueRebate`) and the money is RECEIVED as a finance journal. In
// between, the shop must CLAIM it: a claim document that Finance approves, that is sent to the supplier, and that the money
// is matched to when it arrives. Here:
//
//   • a claim is a sequence of FACTS, never an edited row (hard rule #2): raised → sent (Finance's approval spent on it) →
//     receipts matched to it; a wrong one is WITHDRAWN by a compensating fact that releases only what is still unanswered;
//   • what may be claimed is what is EARNED and not yet received, less what open claims already ask for — so the same
//     money is never claimed twice (`claimableFor`);
//   • a sent claim with money still unanswered after the owner's answer period is OVERDUE. The period is the owner's
//     number: until he sets it the answer is "not set", never a guess (`claimView`).

/** One fact about a claim, as recorded (append-only, oldest first). */
export type RebateClaimFact =
  | { readonly type: 'raised'; readonly claimId: string; readonly schemeId: string; readonly supplierId: string; readonly amountMinor: number; readonly raisedBy: string; readonly raisedAt: string; readonly note?: string }
  | { readonly type: 'sent'; readonly claimId: string; readonly approvalId: string; readonly approvedBy: string; readonly sentBy: string; readonly sentOn: string; readonly sentAt: string }
  | { readonly type: 'withdrawn'; readonly claimId: string; readonly reason: string; readonly withdrawnBy: string; readonly withdrawnAt: string }
  | { readonly type: 'matched'; readonly claimId: string; readonly receiptId: string; readonly amountMinor: number; readonly matchedBy: string; readonly matchedAt: string };

/** A receipt of rebate money as finance's ledger holds it. */
export interface RebateReceiptFact {
  readonly schemeId: string;
  readonly receiptId: string;
  readonly amountMinor: number;
  readonly receivedOn: string;
  readonly reference: string;
}

/** A claim folded from its facts. */
export interface RebateClaim {
  readonly claimId: string;
  readonly schemeId: string;
  readonly supplierId: string;
  readonly amountMinor: number;
  readonly raisedBy: string;
  readonly raisedAt: string;
  readonly note?: string;
  readonly sent?: { readonly approvalId: string; readonly approvedBy: string; readonly sentBy: string; readonly sentOn: string; readonly sentAt: string };
  readonly withdrawn?: { readonly reason: string; readonly withdrawnBy: string; readonly withdrawnAt: string };
  readonly matches: readonly { readonly receiptId: string; readonly amountMinor: number; readonly matchedBy: string; readonly matchedAt: string }[];
}

export type RebateClaimState = 'raised' | 'sent' | 'partly_answered' | 'answered' | 'withdrawn';

/** A claim as every screen shows it. */
export interface RebateClaimView extends RebateClaim {
  readonly state: RebateClaimState;
  readonly matchedMinor: number;
  /** What the supplier still has to pay against it (0 once withdrawn or answered). */
  readonly unansweredMinor: number;
  /** What a withdrawal gave back to be claimed again (0 unless withdrawn). */
  readonly releasedMinor: number;
  /** The day the supplier's answer is due: sent on + the owner's answer period; null when not sent or the period is not set. */
  readonly dueOn: string | null;
  /** Overdue: a sent claim still unanswered after its due day. "not_set" while the owner has not set the period. */
  readonly overdue: boolean | 'not_set';
}

/** Fold the facts into claims — the first `raised` of an id stands; a fact for an unknown claim is ignored. */
export function foldRebateClaims(facts: readonly RebateClaimFact[]): ReadonlyMap<string, RebateClaim> {
  const byId = new Map<string, RebateClaim>();
  for (const f of facts) {
    const cur = byId.get(f.claimId);
    if (f.type === 'raised') {
      if (cur === undefined) {
        byId.set(f.claimId, {
          claimId: f.claimId, schemeId: f.schemeId, supplierId: f.supplierId, amountMinor: f.amountMinor, raisedBy: f.raisedBy, raisedAt: f.raisedAt,
          ...(f.note === undefined ? {} : { note: f.note }), matches: [],
        });
      }
      continue;
    }
    if (cur === undefined) continue;
    if (f.type === 'sent' && cur.sent === undefined && cur.withdrawn === undefined) {
      byId.set(f.claimId, { ...cur, sent: { approvalId: f.approvalId, approvedBy: f.approvedBy, sentBy: f.sentBy, sentOn: f.sentOn, sentAt: f.sentAt } });
    } else if (f.type === 'withdrawn' && cur.withdrawn === undefined) {
      byId.set(f.claimId, { ...cur, withdrawn: { reason: f.reason, withdrawnBy: f.withdrawnBy, withdrawnAt: f.withdrawnAt } });
    } else if (f.type === 'matched' && !cur.matches.some((m) => m.receiptId === f.receiptId)) {
      byId.set(f.claimId, { ...cur, matches: [...cur.matches, { receiptId: f.receiptId, amountMinor: f.amountMinor, matchedBy: f.matchedBy, matchedAt: f.matchedAt }] });
    }
  }
  return byId;
}

/** YYYY-MM-DD plus whole days (calendar arithmetic on the date itself, no clock). */
export function rebateDaysAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A claim as shown: its state, what is matched and unanswered, its due day and whether it is overdue. */
export function claimView(claim: RebateClaim, input: { readonly today: string; readonly answerDays: number | null }): RebateClaimView {
  const matchedMinor = claim.matches.reduce((s, m) => s + m.amountMinor, 0);
  const left = Math.max(0, claim.amountMinor - matchedMinor);
  const withdrawn = claim.withdrawn !== undefined;
  const state: RebateClaimState = withdrawn ? 'withdrawn'
    : claim.sent === undefined ? 'raised'
    : left === 0 ? 'answered'
    : matchedMinor > 0 ? 'partly_answered' : 'sent';
  const unansweredMinor = withdrawn || state === 'answered' ? 0 : left;
  const dueOn = claim.sent === undefined || input.answerDays === null ? null : rebateDaysAfter(claim.sent.sentOn, input.answerDays);
  const awaiting = state === 'sent' || state === 'partly_answered';
  const overdue: boolean | 'not_set' = !awaiting ? false : input.answerDays === null ? 'not_set' : input.today > dueOn!;
  return { ...claim, state, matchedMinor, unansweredMinor, releasedMinor: withdrawn ? left : 0, dueOn, overdue };
}

/** A claim still asking for money (raised or sent, not withdrawn, not answered). */
const isOpen = (v: RebateClaimView): boolean => v.state === 'raised' || v.state === 'sent' || v.state === 'partly_answered';

/**
 * What a scheme may still be claimed for: earned (accrued) and not yet received, less what open claims still ask for. Never
 * the same money twice. `overClaimedMinor` > 0 when open claims ask for more than is outstanding (money arrived that was
 * never matched to them, or an accrual was re-measured down) — said, never hidden.
 */
export function claimableFor(input: { readonly accruedMinor: number; readonly receivedMinor: number; readonly claims: readonly RebateClaimView[] }) {
  const outstandingMinor = input.accruedMinor - input.receivedMinor;
  const openClaimedMinor = input.claims.filter(isOpen).reduce((s, c) => s + c.unansweredMinor, 0);
  const room = outstandingMinor - openClaimedMinor;
  return { outstandingMinor, openClaimedMinor, claimableMinor: Math.max(0, room), overClaimedMinor: Math.max(0, -room) };
}

/** How much of each receipt is already matched to claims (across every claim). */
export function matchedOfReceipts(claims: readonly RebateClaim[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const c of claims) for (const m of c.matches) out.set(`${c.schemeId}\u0000${m.receiptId}`, (out.get(`${c.schemeId}\u0000${m.receiptId}`) ?? 0) + m.amountMinor);
  return out;
}

/** The receipts not (fully) matched to any claim — money that came without a claim, or before one was matched. */
export function unmatchedReceipts(receipts: readonly RebateReceiptFact[], claims: readonly RebateClaim[]) {
  const matched = matchedOfReceipts(claims);
  return receipts
    .map((r) => ({ ...r, matchedMinor: matched.get(`${r.schemeId}\u0000${r.receiptId}`) ?? 0 }))
    .map((r) => ({ ...r, leftToMatchMinor: r.amountMinor - r.matchedMinor }))
    .filter((r) => r.leftToMatchMinor > 0);
}

export type ClaimRefusal = { readonly ok: false; readonly status: 409 | 422; readonly code: string; readonly why: string };
type Judged<T = Record<string, never>> = ({ readonly ok: true } & T) | ClaimRefusal;

/** May this claim be raised? The same claim sent again is "already raised"; never more than may still be claimed. */
export function judgeRaise(input: {
  readonly existing: RebateClaim | undefined;
  readonly claimId: string; readonly schemeId: string; readonly amountMinor: number;
  readonly accruedMinor: number; readonly receivedMinor: number; readonly schemeClaims: readonly RebateClaimView[];
}): Judged<{ readonly alreadyRaised: boolean }> {
  if (input.existing !== undefined) {
    if (input.existing.schemeId === input.schemeId && input.existing.amountMinor === input.amountMinor) return { ok: true, alreadyRaised: true };
    return { ok: false, status: 409, code: 'claim_number_already_used', why: `Claim ${input.claimId} is already raised under scheme ${input.existing.schemeId} for ${input.existing.amountMinor} paise. A claim is never changed; withdraw it and raise a new one.` };
  }
  const room = claimableFor({ accruedMinor: input.accruedMinor, receivedMinor: input.receivedMinor, claims: input.schemeClaims });
  if (input.amountMinor > room.claimableMinor) {
    return {
      ok: false, status: 422, code: 'claim_exceeds_unclaimed',
      why: `Scheme ${input.schemeId} has earned ${input.accruedMinor} paise; ${input.receivedMinor} has been received and open claims already ask for ${room.openClaimedMinor}. At most ${room.claimableMinor} may still be claimed — ${input.amountMinor} would claim money twice or money not yet earned.`,
    };
  }
  return { ok: true, alreadyRaised: false };
}

/** May this claim be recorded as sent? Only a raised claim; re-checked against what is outstanding NOW. */
export function judgeSend(input: { readonly claim: RebateClaimView; readonly accruedMinor: number; readonly receivedMinor: number; readonly schemeClaims: readonly RebateClaimView[] }): Judged<{ readonly alreadySent: boolean }> {
  const c = input.claim;
  if (c.state === 'withdrawn') return { ok: false, status: 409, code: 'claim_withdrawn', why: `Claim ${c.claimId} was withdrawn (${c.withdrawn!.reason}); a withdrawn claim is never sent.` };
  if (c.sent !== undefined) return { ok: true, alreadySent: true };
  const others = input.schemeClaims.filter((x) => x.claimId !== c.claimId);
  const room = claimableFor({ accruedMinor: input.accruedMinor, receivedMinor: input.receivedMinor, claims: others });
  if (c.amountMinor > room.claimableMinor) {
    return {
      ok: false, status: 409, code: 'claim_now_exceeds_outstanding',
      why: `Claim ${c.claimId} asks for ${c.amountMinor} paise, but scheme ${c.schemeId} now has only ${room.claimableMinor} earned and not yet received or claimed (money may have arrived since it was raised).`,
    };
  }
  return { ok: true, alreadySent: false };
}

/** May this receipt (or part of it) be matched to this claim? A sent claim, the same scheme, never more than either has left. */
export function judgeMatch(input: {
  readonly claim: RebateClaimView; readonly receipt: RebateReceiptFact | undefined; readonly receiptId: string;
  readonly amountMinor: number | undefined; readonly matchedOfReceiptMinor: number;
}): Judged<{ readonly amountMinor: number; readonly alreadyMatched: boolean }> {
  const c = input.claim;
  const r = input.receipt;
  if (r === undefined || r.schemeId !== c.schemeId) {
    return { ok: false, status: 422, code: 'receipt_not_on_this_scheme', why: `Finance's ledger holds no rebate receipt ${input.receiptId} under scheme ${c.schemeId}. A claim is answered only by money received under its own scheme.` };
  }
  const prior = c.matches.find((m) => m.receiptId === input.receiptId);
  if (prior !== undefined) {
    if (input.amountMinor === undefined || input.amountMinor === prior.amountMinor) return { ok: true, amountMinor: prior.amountMinor, alreadyMatched: true };
    return { ok: false, status: 409, code: 'receipt_already_matched_to_this_claim', why: `Receipt ${input.receiptId} is already matched to claim ${c.claimId} for ${prior.amountMinor} paise. A match is never changed.` };
  }
  if (c.state === 'withdrawn') return { ok: false, status: 409, code: 'claim_withdrawn', why: `Claim ${c.claimId} was withdrawn; money is not matched to it.` };
  if (c.sent === undefined) return { ok: false, status: 409, code: 'claim_not_sent', why: `Claim ${c.claimId} has not been approved by Finance and sent, so the supplier cannot have answered it.` };
  if (c.unansweredMinor === 0) return { ok: false, status: 409, code: 'claim_already_answered', why: `Claim ${c.claimId} is already answered in full.` };
  const receiptLeft = r.amountMinor - input.matchedOfReceiptMinor;
  if (receiptLeft <= 0) return { ok: false, status: 409, code: 'receipt_already_matched', why: `Receipt ${input.receiptId} (${r.amountMinor} paise) is already matched in full to other claims.` };
  const amount = input.amountMinor ?? Math.min(receiptLeft, c.unansweredMinor);
  if (amount > receiptLeft) return { ok: false, status: 422, code: 'match_exceeds_receipt', why: `Receipt ${input.receiptId} has ${receiptLeft} paise not yet matched; ${amount} is more than that.` };
  if (amount > c.unansweredMinor) return { ok: false, status: 422, code: 'match_exceeds_claim', why: `Claim ${c.claimId} has ${c.unansweredMinor} paise unanswered; ${amount} is more than it asks for.` };
  return { ok: true, amountMinor: amount, alreadyMatched: false };
}

/** May this claim be withdrawn? Not once withdrawn, not once answered in full. */
export function judgeWithdraw(claim: RebateClaimView): Judged<{ readonly alreadyWithdrawn: boolean }> {
  if (claim.state === 'withdrawn') return { ok: true, alreadyWithdrawn: true };
  if (claim.state === 'answered') return { ok: false, status: 409, code: 'claim_already_answered', why: `Claim ${claim.claimId} is answered in full; there is nothing left to withdraw.` };
  return { ok: true, alreadyWithdrawn: false };
}
