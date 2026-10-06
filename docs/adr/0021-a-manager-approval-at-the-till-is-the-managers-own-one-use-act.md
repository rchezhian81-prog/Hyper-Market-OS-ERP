# ADR 0021 — A manager's approval at the till is the manager's own act: their PIN, checked by the store computer, bound to one transaction, used once

- **Status:** Accepted (owner program directive — the audit's Wave 2 critical findings are repaired in order; the second
  half of PF-02, named as "not in this decision" by ADR-0020)
- **Date:** 6 October 2026
- **Context:** The audit's **PF-02 (CRITICAL)** has two halves: *"a typed staff or manager identifier is treated as
  identity/approval"*. ADR-0020 closed the first: the cashier is a person the store computer verified. The second is
  still open: wherever the till needs a manager — a refund at or above the shop's approval threshold, every return
  without a receipt, the refunded difference on an exchange (§28, M13-FR-01/03) — the screen asks the manager to "scan
  your badge or key your staff code", and whatever is typed becomes `approvedBy` on the refund record
  (`apps/pos/web/app.js`, `apps/pos/src/browser-entry.ts` `decidedAtTheLane`). The engine checks only that the name
  differs from the cashier's; head office checks only that the name holds authority. Nothing proves the manager was
  there, and one "approval" could be written onto any number of refunds. The roadmap's control is *"authenticated
  one-use manager approval"*; §28 forbids self-approval; hard rule #1 forbids a network call on the till path.

## Decision

1. **The manager proves themselves with their own till PIN, at the till, to the store computer.** The same PIN and the
   same verifier as ADR-0020 (one credential per person, issued on the box), checked offline, with the SAME guess
   limits: a wrong PIN through an approval counts towards the five-per-staff-ID and twenty-per-till locks of sign-in,
   so the approval door is not a second place to guess.
2. **The store computer decides, and only it issues an approval** (`POST /lane/approvals`). It refuses unless: the
   request comes from a live till session on this lane (the cashier asking); the manager is NOT that cashier (§28);
   the manager's PIN matches; the manager holds the authority to approve a refund (`pos.return.approve`) in the
   store pack's role register; the request names what it is for — the kind (a refund on a bill, a return without a
   receipt, an exchange's refunded difference), the bill (for a refund or an exchange) and the amount — and a reason.
3. **The approval is bound and short-lived.** It is minted for exactly that kind, that bill, that amount, that cashier
   and that till, and expires five minutes after it is given. It is NOT bound to the refund's number: the number comes
   from the till's gap-free range and is allocated only when the refund is recorded, so a refused approval never
   leaves a gap.
4. **Used once, at the disk.** When the refund record reaches the box, the box refuses it **before the disk** unless
   either no approval is needed (the shop's threshold from the pack's `servicePolicy`; a box that holds no service
   policy treats every refund as needing one, as the till does) or it carries an approval this box issued that matches
   the record's kind, bill, amount, cashier and till, has not expired, and has not been used by a DIFFERENT refund. A
   name typed into `approvedBy` with no approval behind it is refused. The approval is then marked used by that refund;
   the same refund re-sent after a lost reply is still accepted (it is the same use), another refund is not.
5. **Evidence.** Every approval given and every use is appended to an fsync'd log (`till-approvals.log`, hard rule #6),
   folded at start, so a restart neither forgets an approval nor lets a used one be used again. The PIN is never
   written; the refund record carries `approvalId` and the box stamps `approvalVerified { approvalId, approvedBy }`.
6. **The hosted copy.** There is one browser sign-in per person there, and the manager is by definition a different
   person, so the hosted copy uses the same PIN path: a manager who is to approve refunds on the hosted till needs a
   till PIN issued on that box (runbook, the same command). No header is trusted for an approval.

**Not in this decision (the remaining slice of Wave 2b-v, 2b-v-c):** head office treating the approver on a synced
refund as an approval object and flagging a synced sale or refund that lacks the store computer's stamp; an
approval-limit register (how much each manager may approve); approvals at head office's own service desk; the
manager screen's day-reopen approval.

## Consequences

- PF-02 is closed at the till: the cashier and the approving manager are both people the store computer verified,
  offline, and an approval cannot be invented, reused or moved to another refund.
- Every manager who approves refunds needs a till PIN (the same one they would use to work a till).
- A refund needs one more act at the till — the manager's PIN — on top of the badge and the reason.
- Tests that take refunds through a real store computer now obtain an approval from that box first.

## Reconsider-when

The identity server (ADR-0019) is live on the store box (approvals then may also be given by a manager's own device
session), or an approval-limit register exists (the box then also checks the amount against the manager's limit).
