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
