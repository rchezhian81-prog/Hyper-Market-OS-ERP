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
