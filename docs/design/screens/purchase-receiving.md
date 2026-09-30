# Screen spec — Purchase / Supplier & Receiving (Stage 3)

- **Surface:** Purchase/Supplier + receiving (§27) · **Modules:** M06, M07, M30, D03 · **Design bar:** kill the line-by-line invoice pain (audit A-03); enforce separation of duties without slowing the buyer.

> Built on `../design-system.md`.

## Screens & states (§27 Purchase/Supplier row)
Supplier workbench · Requisition · RFQ · Quotation comparison · PO · Amendment ·
ASN · Receiving/QC · Invoice match · Claims · Scorecard. All handle §27.1 states.

## Invoice import & match (the priority)
- **Bulk supplier-invoice import** (M30-FR-01, D03-FR-02): upload/scan → **validate → preview (with row errors) → approve → commit**; nothing commits until approved.
- Three-way **PO-GRN-invoice match** (M07-FR-04) shows variances clearly; out-of-tolerance blocks payment pending approval.
- **Interaction target:** importing a real 80-line invoice is one guided flow, dramatically faster than manual entry (measured against today's time).

## Supplier workbench
- Onboarding with **bank-change verification** (M06-FR-01) — the verification/approval step is deliberate and explicit; the creator can't approve the bank details (§28).

## Requisition → RFQ → PO
- Quote comparison highlights cheapest/fastest; PO approval bound to value limits; **a user can't requisition, receive and pay the same deal** (§28) — the UI reflects the role's allowed actions but the server enforces.

## Receiving/QC (handheld)
- Scan PO/ASN → capture qty/batch/expiry/MRP/cost/condition → quarantine failures → GRN. **Works offline** (§31); conflicts surface on sync.

## Offline / state (§31)
- Receiving is queue-capable offline; purchase drafting can cache; issuing/approval is online (no unsafe stale approval).

## Acceptance (QG-02 / A-03)
- An 80+ line invoice imports correctly in one go; a bad row is previewed before anything commits.
- A junior user cannot approve a large purchase (blocked).
- A receiver cannot change the PO price; receiving completes with the cable out.

## Measured (SP-6 — the receipt folds into the order; quarantined stock gets a disposition, owner's Option 2 directive of 30 September 2026)
No screen changed shape in this slice; what changed is what a delivery DOES when it is booked in. Until now the buyer's
order stayed fully outstanding however much arrived (F01): the receipt and the order were two records nobody joined.
Now (`tests/audit-observations/procurement.test.ts` case 1, `tests/integration/goods-receipt.test.ts`,
`tests/integration/goods-receipt-synced-route.test.ts`, `tests/integration/goods-receipt-disposition.test.ts`):
**a delivery against an issued order** — on the dock route or booked in on the manager's screen and relayed through the
box — posts what came into our custody against the order in the same append as its stock, so the order's remainder falls
with the goods; the ordered quantity a receipt is measured against is the order's, never the sender's; a delivery with no
order, an unknown order or an order nobody has approved yet is still received, said, and folds into nothing.
**Quarantined or refused stock** on a delivery now waits for a second person who is not the receiver to dispose of it:
accept (released to stock once, after inspection), return (back to the supplier) or claim (kept, value claimed) — each
recorded once per line with the delivered value the supplier account will work from (SP-7); refused (expired) stock can
only be returned or claimed. **Still recorded, not dropped:** the handheld's receiving scans are not yet assembled into a
GRN (SP-6b); the supplier return / claim does not yet reach the supplier's account, statement or a debit note (SP-7); the
review screen does not yet show the held quantity, offer the excess decision or the disposition (SP-9); physical-device
verification and staff UAT — PENDING.
