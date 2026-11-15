# CR-01 OI-13-A12 — Supplier-bill match explainer (requirement)

**Status:** BUILT (14 November 2026). **Decided by:** the owner, OB-763 option B (14 Nov 2026, in writing: "763 B") — build
A12 before go-live (Friday 20 November 2026), on fixed rules only, ₹0 a month. **Source:** CR-01 item OI-13
(`docs/roadmap/roadmap-v2.2-change-CR-01-owner-installable-product.md`), the catalogue entry "A12"
(`docs/requirements/CR-01-OI-13-agent-catalogue.md`), OB-712 A. **Target release:** the checked start (go-live).

## What it does

When a supplier bill does not match its purchase order and the goods received (M07-FR-04, the three-way match head office
already records), A12 explains **why** in plain sentences — one per difference, each naming the product and the figures
it came from ("p-oil: the bill says 50, we received 48 — 2 more billed than received"; "the bill price is ₹0.12 a unit
higher than the order") — says how much is held back, and **drafts** the query to the supplier for what the supplier must
correct (a corrected bill or a credit note).

## What it reads

The latest three-way-match verdict of each bill (`InvoiceMatched`: lines, quantity and price differences, held-back
amount, flags such as "no purchase order", "order not issued", "another supplier", "billed beyond the order"), the bill
as captured (its lines), and the order it names. Nothing else. No customer's personal data (`supplier_bill_review`
purpose, empty allowlist).

## What it may do — and never do

- **Tools (allowlist):** `read_supplier_bill`, `read_purchase_order`, `read_goods_receipt`, `read_price_history`,
  `explain_bill_mismatch`, `draft_supplier_query`, `draft_debit_note_request`. Only read, explain and draft.
- **Never:** pay a bill, issue a debit note, change a figure, or approve anything. No forbidden tool is added
  (`FORBIDDEN_TOOLS` unchanged). A12 is **not** an auto-approve kind — its drafts carry no `act`, so no owner-set limit
  (OI-12) can ever approve one.
- **Who decides:** the accounts person (approver role `accountant`), through the bill's own routes — match it again once
  the supplier corrects it (`POST /v1/purchase/invoices/:invoiceId/match`), or the supplier's debit note
  (`POST /v1/purchase/suppliers/:supplierId/debit-notes/:debitNoteRef/issue`). Until then the bill stays at the lowest of
  order, receipt and bill.

## Governance (as for A01–A10)

Starts **switched OFF**; runs only when the owner switches it on by name. Its own monthly spend ceiling (₹0 while on
rules). The scoped kill switch (A12 alone), the shop-wide kill switch and the shop's AI budget all stop it. Every draft
carries its evidence — a draft without evidence is refused. Every draft carries a confidence band (a recorded fact: the
figures are as recorded; it cannot know about a phone agreement or a typing mistake on the paper bill). It is in the
fixed evaluation set (v7): a grounded explanation, an "I do not know", hostile text on a bill, and a model reaching for
payment or a debit note — all must pass before release.

## Acceptance tests

| # | Acceptance criterion | Test |
|---|---|---|
| AC-1 | A bill whose latest match is clean gets no explanation | `tests/unit/oi13-a12-bill-mismatch-explainer.test.ts` |
| AC-2 | Each difference is one plain sentence naming the product and its figures; order-level reasons said | same |
| AC-3 | The held-back money is said; a supplier query is drafted only for what the supplier must correct | same |
| AC-4 | It never claims to have paid, approved, issued or written off anything | same |
| AC-5 | Read / explain / draft tools only; a payment or debit note is refused even when a model asks | `tests/unit/ai-authority.test.ts` |
| AC-6 | Starts off; explains a REAL match with three pieces of evidence; moves nothing on the purchase side; never rule-approved; own switch; kill switch; survives a restart — in memory and on PostgreSQL | `tests/integration/oi13-a12-a14-explain-bills-and-tills-and-commit-nothing.test.ts` |
| AC-7 | Evaluation set v7: grounded, "I do not know", injection and over-reach cases pass; release gate | `tests/unit/ai-governance-rules.test.ts`, `tests/guardrails/the-evaluation-set-gates-the-release.test.ts` |
| AC-8 | Shown on the Assistant drafts page, English and Tamil; a person agrees or says "not right" with a reason, which commits nothing | `tests/e2e/oi13-a12-a14-explanations-on-the-assistant-drafts-page.e2e.ts` |

## Open (owner decision)

**OB-780** — whether the accountant role may open the Assistant drafts page to read and decide A12's drafts. Today only
the owner and the store manager can (they hold `ai.proposal.read` / `ai.proposal.decide`); the accountant acts on the
bill itself as before. See `docs/registers/decisions.md`.
