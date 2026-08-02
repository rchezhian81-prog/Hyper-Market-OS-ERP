# Screen spec — Migration (Stage 3)

- **Surface:** Migration (§27) · **Programme:** MG-01–MG-12 · **Workflow:** WF-19 · **Design bar:** no cutover without signed control totals (QG-07); every exception is kept, never deleted (hard rule #6); a tested rollback path at all times.

> Built on `../design-system.md`. An internal, controlled surface used during the R3 data
> cutover — never pointed at production from dev/test (hard rule #7).

## Screens & states (§27 Migration row)
Source profiling · Field mapping · Cleaning & exceptions · Trial-load run ·
Reconciliation control totals · Delta load · Parallel-run compare · Cutover checklist ·
Rollback · Archive. All handle the §27.1 states.

## Map → clean → trial (MG-01–MG-05)
- Source profiling and a **field-mapping** workbench.
- Cleaning resolves duplicate products/barcodes/suppliers/customers, invalid tax,
  negative stock and incomplete batches (MG-04) — each unresolved item is a **kept
  exception**, never silently dropped (hard rule #6).
- **Trial loads** are repeatable, full-volume and run in **non-production only**
  (hard rule #7).

## Reconcile → cutover → rollback (QG-07)
- **Control totals** for migration, stock, financial, tax and loyalty must be **signed**
  before cutover; the screen shows each total, its difference, and who signed it.
- Delta load, **parallel-run** comparison, a guided **cutover checklist**, and a tested
  **rollback** — rollback is one clearly-labelled action, never improvised.
- Opening balances posted; the legacy dataset archived (immutable, retained).

## Offline / state (§31)
- Runs against controlled environments only; production is never touched from dev/test
  (hard rule #7); progress and every exception count are always visible.

## Acceptance (QG-07 / QG-02)
- Cutover is blocked until every control total is signed.
- Migration exceptions cannot be deleted — only resolved, or carried with a reason.
- A rollback is demonstrated before go-live.
- No trial or delta run points at production data.
