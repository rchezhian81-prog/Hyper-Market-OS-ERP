# `packages/tally-export/`

A Tally-importable voucher file from the shop's own journals — **WF-05** ("→ AP/Tally"), **M23-FR-04**. Pure; no I/O.

Tally is a **destination, not the book of record** (see `packages/period-close`). This package writes a copy of balanced
journals in Tally's XML import format, and checks it with a stand-in for Tally's own import.

## `src/tally-xml.ts` — `buildTallyVouchers`

- **One journal is one voucher**, keyed `REMOTEID="sre:<entryId>"`. Re-importing the same file names the same vouchers, so
  the month is never doubled.
- **Ledger names are the accountant's map** (account code → Tally ledger). A journal touching an unmapped code is **not
  written**; it is an exception by name, and the export says it is incomplete (P-08).
- **Unbalanced, undated or un-narrated journals are never written.**
- Tally's sign convention: a debit is `ISDEEMEDPOSITIVE` Yes with a negative `AMOUNT`; a credit is No and positive.
  Amounts are whole paise shown as rupees with two decimals; no floating point.
- Control totals (vouchers, debits, credits) travel with the file.

## `src/tally-validator.ts` — `validateTallyImport`

Reads the file back with its own small XML reader and amount parser (independent of the writer) and refuses what Tally
would refuse: a malformed envelope, a missing or repeated REMOTEID, a bad date, a sign that disagrees with
`ISDEEMEDPOSITIVE`, a voucher that does not balance, totals that differ from the control totals. The real proof is the
accountant importing the file into Tally (an outside party, AVR-09).

Tests: `tests/unit/tally-export.test.ts`.
