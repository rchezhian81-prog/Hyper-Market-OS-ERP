# ADR 0022 — A refund approval at head office is an approval object the approver gives in their own session, spent once

- **Status:** Accepted (owner program directive — the audit's Wave 2 critical findings are repaired in order; the
  head-office half of PF-02, named "approvals at head office's own service desk" by ADR-0021)
- **Date:** 6 October 2026
- **Context:** The audit's **PF-02 (CRITICAL)** reproduction was made at head office, not at the till: *"Refund body
  named a provisioned manager who never authenticated or approved; both requests settled. Cloud role lookup proves that
  name has authority, not that the person approved this action"* (`services/pos/src/returns.ts:378-391`). The same
  pattern stood on every head-office route that pays money back: a refund on a bill (`approvedBy`), a return past the
  shop's window (`outOfWindowApprovedBy`), a return without a receipt (`approvedBy`), and the refunded difference on an
  exchange (`approvedBy`). The audit's smallest next action: *"consume a separate authenticated, transaction-bound
  manager approval (amount/refund hash, expiry, one-use). Keep later sync flags for facts already committed."* §28
  forbids self-approval; hard rules #2 and #10 forbid overwriting and silent last-write-wins.

## Decision

1. **The approver gives the approval themselves, in their own signed-in session** — `POST /v1/pos/refund-approvals`,
   gated on `pos.return.approve`. The approver is the caller's token, never a body value. An approval is for ONE kind
   (`refund` on a bill, `exchange_refund` for an exchange's refunded difference, `no_receipt_return`, `out_of_window`
   for a return past the window), ONE bill (none for a return without a receipt), ONE amount in paise, and ONE named
   person who will process it, with a reason. It is refused when that person is the approver (§28), when head office
   does not know them, or when they may not process refunds. It expires fifteen minutes after it is given. It is an
   append-only event (`RefundApprovalGiven`); a replay of the same request is the same approval (kernel idempotency).
2. **The refund names the approval, not a person.** The refund, exchange and no-receipt routes read `approvalId` (and
   `outOfWindowApprovalId` for the window). A body that names an approver (`approvedBy`, `outOfWindowApprovedBy`) with
   no approval behind it is refused by name — `approver_named_without_approval` — and nothing moves. That is the
   audit's reproduction, now a test.
3. **The approval is spent only by the refund it was given for.** It must exist; match the refund's kind, bill, amount
   and processor (the signed-in caller); not have expired; and not have been spent by a different refund. Its approver
   must STILL hold the authority when it is spent — a manager who has left (Wave 2b-i · PA-02 revocation) approves
   nothing more. The same refund re-sent after a lost reply may name it again (the same use; the register dedups the
   refund itself).
4. **Spent atomically, once, even under a race.** The `RefundApprovalUsed` event is appended in the SAME batch as the
   refund, under the guard that already stops two refunds of one bill (Wave 2a, `refund:<saleId>`); a return without a
   receipt has no bill, so it is guarded by the approval's own key (`refund-approval:<approvalId>`), read BEFORE the
   approval is judged. Two refunds spending one approval at the same moment: one lands, the other is refused by name
   (`concurrent_change`, 409, or `approval_already_used`), proven on real PostgreSQL. The use event's id names the use
   (approval + refund) and its idempotency key names the approval, so the race resolves through the key and the guard
   — never a raw duplicate-id error.
5. **The record says who approved and with what.** The refund record carries `approvedBy` (taken from the approval)
   and `approvalId`; the audit trail seals the approver as before.
6. **Head-office till cash records who did it.** The direct cash-movement route stamps `performedBy` from the signed-in
   caller (M14-FR-01), and a till is put only in the name of a person head office knows who holds till authority
   (`custodian_unknown` / `custodian_lacks_authority`). Later movements must name the current holder (the existing
   chain rule), so a float can still come back from someone who has since left.

**Not in this decision (2b-v-d, next):** the store computer's own stamps (`operatorVerified`, ADR-0020;
`approvalVerified`, ADR-0021) travel on synced sales and refunds signed by the box, and head office flags a synced fact
that lacks them (`cashier_not_verified_at_store`, `approval_not_verified_at_store`) — a flag, never a refusal, because
the money already moved at the till (the audit: *"keep later sync flags for facts already committed"*). Also outside:
an approval-limit register; and two head-office routes found during this slice that still take a typed approver's name
— a below-cost price change (`approval.decidedBy`, `services/pricing/src/index.ts`) and a margin-losing promotion launch
(`approvedBy`, `services/pricing/src/promotions.ts`) — recorded in the repair plan as their own slice (2b-vi), to get the
same approval object.

## Consequences

- PF-02 is closed at head office's own desk: a refund there needs the approver's own act, bound to that refund, once.
- Approving a desk refund is two acts by two people: the manager approves (their session), then the cashier processes
  (theirs). Any screen or integration that refunds at head office must first ask the approver for an approval.
- Tests that take refunds at head office now obtain an approval through the real route (`tests/support/refund-approval.ts`).
- The `/v1/pos/refund-approvals` route is added to the API surface (API-05).

## Reconsider-when

An approval-limit register exists (the approval route then also checks the amount against the approver's limit), or
head office gains a desk-refund screen (it then shows the approval request to the approver's own queue).
