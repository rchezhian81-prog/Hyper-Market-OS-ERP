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

## Measured (SP-7a — the invoice exists, and the match compares three records, owner's Option 2 directive of 30 September 2026)
The buyer's screen said "Invoice saved" and saved nothing (audit finding F02): the capture committed into a callback that
kept the lines in a local variable, so the same screen's match found no invoice and a second capture went through. Now the
session takes the **durable device queue** as a required argument — the same mechanism the manager screen and the
handhelds use — and a capture is on the device BEFORE the screen says saved: the banner now says *Invoice saved on this
device*, the new **Invoices saved on this screen** list shows each one with the five shared state words (saved on this
device · trying again · with the store computer · posted at head office · refused, with the reason), in English and
Tamil, and the list is the same after a reload. The queue is handed to the store computer after every capture and when
the page regains the network or the buyer's attention (no timer: nothing on this page runs on a clock). A new
**Purchase order number (if you have it)** field lets the buyer name the order; head office matches against ITS copy.
At head office the invoice is a record captured as the paper says it, both people are re-verified, and the three-way
match compares the STORED invoice with the STORED order and the receipts folded into it (F04's match half) — the screen's
own match still runs the same shared rule over what the box served plus what this device queued. Proven in the session
model (`tests/unit/erp-buying-session.test.ts`), the inverted observation (`tests/audit-observations/procurement.test.ts`),
the honesty guardrail, and the real box against the real kernel
(`tests/integration/buyer-invoice-reaches-the-cloud-through-the-edge.test.ts`). **Still recorded, not dropped:** the
matched payable does not reach a supplier account, statement or journal (SP-7b); the supplier workbench (§ above) is not
built; the box-served buyer page with its relay is not yet browser-verified (SP-9); physical-device verification and UAT
PENDING.

## Measured (SP-7b — what the supplier is owed is read, not typed; the rejected excess goes back, owner's Option 2 directive of 30 September 2026)
No screen changed shape in this slice; what changed is that the delivery, the invoice and the order now add up to ONE figure
per supplier that head office can read and the accountant can post. **What a supplier is owed** is a projection over the
records the earlier slices made durable — the invoice as the paper said it, its latest three-way match, the order and the
receipts folded into it: an invoice nobody has matched is owed nothing and shown wholly withheld; a matched one owes the
lowest of the three with the rest in dispute; a second person's RETURN or CLAIM of quarantined stock raises a debit note for
exactly the quantity that was received and paid for, at the delivered cost; refused (expired) stock is listed as never owed,
because the match already held it back and a debit note would count the same shortfall twice; a rejected over-delivery is a
return pending until the goods have gone back, recorded once on `POST /v1/inventory/goods-receipt/:grnId/excess/returned`
— which takes the units off the shelf position only where the handheld's scans had put them there. **The match tolerances
are the owner's** (`POST`/`GET /v1/purchase/match-policy`), applied to every invoice and named on every verdict; the buyer's
screen never sends one. Proven through the real API (`tests/integration/supplier-account.test.ts`,
`tests/integration/goods-receipt-assembled.test.ts`) and in the pure folds (`tests/unit/supplier-account-fold.test.ts`,
`tests/unit/goods-receipt-assembly.test.ts`). **Still recorded, not dropped:** the supplier workbench (§ above — master
record, KYC documents, risk status, verified bank state) and a Suppliers screen showing the account are SP-7c; a debit note
has no statutory number yet; the review screen does not offer the disposition, the excess decision or the return (SP-9);
physical-device verification and UAT PENDING.

## Measured (SP-7c — the supplier has one record and one balance, and gets paid safely, owner's Option 2 directive of 30 September 2026)
The Supplier workbench (§ above) now has its records; its screen is the next slice (SP-7d). A purchase user PROPOSES a
supplier — name, GSTIN, contact, payment terms, compliance documents — and a DIFFERENT person with the authority makes it
active; the proposer never can, and the person who created a supplier can never approve where its money goes (the
bank-details route refuses them by name). A supplier whose name or GSTIN matches another is SAID as a possible duplicate,
not refused and not silently taken. `GET /v1/purchase/suppliers` is the list a screen will render: every supplier the
records name, those needing a person first, each with its hold, its verified bank account, its balance and every reason
in words. A PAYMENT is a fact a second person approved, recorded once and moving no money: it is refused — nothing
recorded — for a supplier under a hold, for a bank payment with no independently verified account, for an account another
holder shares, for the approver being the payer, and for more than the balance owed. A second bill against the same order
pays nothing for goods the first bill already claimed, and the pair is flagged. A debit note is issued under the shop's
own `DN-` number series, once. The supplier's own portal statement reads the same account. Proven through the real API
(`tests/integration/supplier-master.test.ts`, `tests/integration/duplicate-bank.test.ts`) and the pure pieces
(`tests/unit/purchase-match-lines.test.ts`). **Still recorded, not dropped:** the Suppliers screen (SP-7d); an unapproved
supplier can still be issued an order (only a hold refuses one); compliance documents are recorded, not yet checked at
the order; physical-device verification and UAT PENDING.

## Measured (SP-7d — the supplier has one face on the screen, owner's Option 2 directive of 30 September 2026)
The Supplier workbench (§ above) is now a screen the store computer serves at `/suppliers`, in English and Tamil. It
lists every supplier the records name with the ones needing a person at the top — a hold shown as an error with the
word, then the most money owed — and says every reason in plain words: no record yet, waiting for approval, looks like
another supplier, shares a bank account, no verified bank account to pay, bills not matched, bills blocked, money
withheld, refused goods still to go back, billed more than ordered. Each row carries its verified bank account or its
absence and the ONE balance the matched bills say, read live from head office; Refresh re-reads it. A purchase user
sees an **Add or update a supplier** form (code, name, GSTIN, phone, email, payment terms) and nothing else; an
approver sees **Approve a proposed supplier** offering only the suppliers somebody ELSE proposed, with a reason box
that is the record. The proposer of a supplier is told so on the row and is refused on the screen before anything is
sent; head office refuses them again. A reader without the right sees a plain "no permission" and no controls. Proven
in a real browser (`tests/e2e/suppliers-delivery.e2e.ts`), pinned by `tests/guardrails/the-suppliers-screen-is-usable.test.ts`
and `tests/unit/erp-suppliers-session.test.ts`, and served by the real box in `tests/integration/the-screens-are-fed.test.ts`.
**Still recorded, not dropped:** payments, quarantined-stock disposition and debit-note issue have no screen yet (SP-9);
an unapproved supplier can still be issued an order (only a hold refuses one); compliance documents are recorded, not
yet checked at the order; the browser leg runs against a stub cloud; physical-device verification and UAT PENDING.
