# CR-01 OI-13-A14 — Cash-office variance explainer (requirement)

**Status:** BUILT (14 November 2026). **Decided by:** the owner, OB-763 option B (14 Nov 2026, in writing: "763 B") — build
A14 before go-live (Friday 20 November 2026), on fixed rules only, ₹0 a month. **Source:** CR-01 item OI-13
(`docs/roadmap/roadmap-v2.2-change-CR-01-owner-installable-product.md`), the catalogue entry "A14"
(`docs/requirements/CR-01-OI-13-agent-catalogue.md`), OB-712 A. **Target release:** the checked start (go-live).

## What it does

At day close, when a till is over or short (M14, the blind count against what the till should hold) and nobody has signed
the over/short off yet, A14 lays out the **likely causes from the records**, most specific first, each naming the record
it came from:

1. a sale or refund of exactly the difference on the tender that would explain it — a bill recorded as cash that may
   have been paid by UPI or card (short), a bill recorded as UPI/card that may have been paid in cash (over), a refund
   recorded on card/UPI that may have been paid out in cash (short), a refund recorded as cash that may have gone back by
   UPI/card (over);
2. a round sum (a multiple of ₹100) — a cash pickup or safe drop not entered (short), or cash put in and not entered (over);
3. a difference inside the till's own tolerance — most often change given wrongly;
4. a count entered as a total only — a note-by-note recount shows what is missing;
5. when nothing in the records explains it, it says so and asks for a recount with a second person. It never guesses.

## Records, not people

A14 never names the person who counted the drawer and never uses a word of blame (theft, stole, fraud, suspect). A
difference is not a finding against anyone. A pattern over many days remains the security officer's, through A07.

## What it reads

The till close (expected, counted, over/short, tolerance, pickups entered, whether the count was note by note), whether
the over/short was already signed off, the till's own sales by tender in that trading day and shift, and the refunds paid
out in the shift. No customer's personal data (`cash_variance_review` purpose, empty allowlist).

## What it may do — and never do

- **Tools (allowlist):** `read_till_close`, `read_cash_movements`, `read_sales_by_tender`, `read_settlement`,
  `explain_cash_variance`, `draft_variance_note`. Only read, explain and draft.
- **Never:** write off a shortage, sign the over/short off, or change a cash balance. No forbidden tool is added. A14 is
  **not** an auto-approve kind — its drafts carry no `act`, so writing off a shortage is never auto-approved.
- **Who decides:** the manager, through the ordinary over/short sign-off (`POST /v1/shifts/:shiftId/over-short/review`,
  never the person who counted the drawer). Once signed off, the till drops off A14's list on its own.

## Governance (as for A01–A10)

Starts **switched OFF**; its own monthly spend ceiling (₹0 while on rules); the scoped and shop-wide kill switches and the
shop's AI budget stop it; a draft without evidence is refused; every draft carries a confidence band (medium when a rule
found likely causes, low when nothing explains it). It is in the fixed evaluation set (v7): a grounded explanation, an
"I do not know" (who took the money), hostile text on a till close, and a model reaching for a write-off — all must pass.

## Acceptance tests

| # | Acceptance criterion | Test |
|---|---|---|
| AC-1 | A balanced till, or one already signed off, gets no explanation | `tests/unit/oi13-a14-till-variance-explainer.test.ts` |
| AC-2 | Likely causes listed from the records, most specific first, each naming its record | same |
| AC-3 | Nothing explains it → said, with a recount by two people; a total-only count is said | same |
| AC-4 | No person named; no word of blame | same, and the integration and browser tests |
| AC-5 | Read / explain / draft tools only; a write-off is refused even when a model asks | `tests/unit/ai-authority.test.ts` |
| AC-6 | Starts off; explains a REAL relayed till close from the till's own sale; moves nothing; own switch; kill switch; restart; drops off once signed off — in memory and on PostgreSQL | `tests/integration/oi13-a12-a14-explain-bills-and-tills-and-commit-nothing.test.ts` |
| AC-7 | Evaluation set v7 cases pass; release gate | `tests/unit/ai-governance-rules.test.ts`, `tests/guardrails/the-evaluation-set-gates-the-release.test.ts` |
| AC-8 | Shown on the Assistant drafts page, English and Tamil; "not right" needs a reason; a decision commits nothing | `tests/e2e/oi13-a12-a14-explanations-on-the-assistant-drafts-page.e2e.ts` |
