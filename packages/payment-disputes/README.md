# `packages/payment-disputes/`

Card and UPI **payment disputes** (chargebacks) — roadmap gap **C14** (R3), NPCI UPI dispute rules and the RBI Payment
Aggregator Directions. Pure and deterministic.

- `respondByFor` — the answer-by date: **UPI, 15 days after the notice was received** (computed, never typed); a card,
  the reply-by date the acquiring bank's notice states.
- `disputeViews` — each dispute open, answered, won or lost; overdue when unanswered past its due date; answered late.
- `disputeExceptions` — the **owner's exception** list: every dispute not answered by its due date.
- `lossEntryFor` — the **compensating entry** a lost dispute posts (chargeback loss against the card/UPI settlement
  receivable); the sale is never edited (hard rule #2).

The provider reference is a case or transaction reference, never card data (hard rule #3). The register and routes are
`services/finance/src/payment-disputes.ts`. The refund-to-source rule (OB-144) is `packages/returns/src/refund-channel.ts`.
