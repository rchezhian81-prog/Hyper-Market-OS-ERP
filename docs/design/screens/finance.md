# Screen spec — Finance (Stage 3)

- **Surface:** Finance (§27) · **Modules:** M23, D10 · **Design bar:** the books reconcile daily with visible control totals; ledgers are append-only (hard rule #2); no card data ever (hard rule #3).

> Built on `../design-system.md`.

## Screens & states (§27 Finance row)
Ledger mapping · Journals · AP/AR · Cost centres · GST & credit/debit notes ·
Cash/bank/gateway/refund reconciliation · Tally bridge · Period close ·
Control-total validation. All handle the §27.1 states.

## Reconciliation — the priority
- Cash/bank/payment-gateway/refund reconciliation (M23 / D10) shows matched vs
  unmatched with the **difference always visible** (P-08) — never a silent tie-out.
- POS tender → bank/gateway → ledger tie; variances become exceptions with a named
  finance/owner action, not an auto-adjustment.

## Ledgers & journals (hard rule #2)
- Ledgers are **append-only**; a correction is a **compensating journal**, never an edit
  of a posted balance — the UI offers "post correction", never "edit balance".
- GST evidence, credit/debit notes and cost-centre mapping (M23 / D10).

## Tally bridge & period close
- Tally connector with **control totals on both sides**; period close is **guarded** —
  blocked while reconciliation differences or unposted days remain, with a clear list.
  Close is audited; reopen is controlled and audited.

## Card data (hard rule #3)
- Screens only ever show provider **tokens** and last-4; no PAN, CVV or expiry is stored,
  displayed or exportable.

## Offline / state (§31)
- Finance is online (no unsafe stale approval or period mutation); drafts may cache
  where approved.

## Acceptance (QG-02 / QG-07)
- A posted balance cannot be overwritten — only a compensating entry is possible.
- Period close is blocked with a named list when totals do not tie.
- Tally control totals match on both sides; no screen or export reveals a card number.

## Measured (SP-7b — the supplier account posts through the mapping and reconciles, owner's Option 2 directive of 30 September 2026)
No finance screen changed shape in this slice; the AP/AR row above gained its first real payable. The supplier account the
purchase side projects (`docs/design/screens/purchase-receiving.md`, SP-7b) is posted by the accountant on
`POST /v1/finance/payables/post` through the same ledger mapping the day book uses — a matched invoice credits the supplier
and debits the goods-received-not-invoiced clearing, a re-match that owes less REVERSES by its own journal (never an edit of
the first, hard rule #2), a debit note is the mirror image, posted once — and every voucher is a journal like any other, so the
period fold and the close gate see it. A kind the mapping does not name is a VISIBLE exception until the accountant names
it; a re-run posts nothing twice. `GET /v1/finance/payables` shows the journals, the exceptions with their state, and the
**reconciliation**: per supplier, what the purchase register says is owed against what the ledger holds on the control
account the mapping names — two figures reached two different ways (QG-07), the difference always visible (P-08) and the
unposted listed, never a silent tie-out. Proven through the real API (`tests/integration/supplier-account.test.ts`) and
in the pure engine (`tests/unit/finance-payables.test.ts`). **Still recorded, not dropped:** input GST on purchase invoices
is not captured; supplier payments are not recorded against the account (bank reconciliation is externally gated); the
payables reconciliation is not yet one of the period-close control totals; no screen shows the account or the journals
(SP-9); a CA has not reviewed the suggested payables rules (AVR-09).
