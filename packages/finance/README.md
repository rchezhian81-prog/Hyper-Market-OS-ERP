# `packages/finance/`

Finance / accounting bridge — **M23-FR-01** (ledger mapping → journals) and **M23-FR-02**
(GST posted as a mapped component). Make the money reconcile so a **CA can sign the control
totals** (QG-07).

- **`src/posting.ts`**
  - `postJournal(input, map)` — turns one operational transaction into a **balanced
    double-entry journal** using a configurable `PostingMap` (the chart of accounts — choose-able
    per tenant). Posting is **deterministic from the mapping**; legs post in rule order. GST is
    just a mapped `tax` component posted to the GST-output account.
  - Refuses anything wrong, **never silently unposted** (P-08): `UnmappedKindError` for an
    unmapped kind, `MissingComponentError` if a leg's amount was not supplied, and
    `UnbalancedJournalError` if the legs do not balance (debits ≠ credits). Zero-amount legs
    (e.g. tax on an exempt sale) are omitted.
  - `postBatch(inputs, map)` — posts many, returning the entries **and** the failures as
    **visible exceptions** (never dropped) for review.
  - Finance only **reads** operational data and posts — it never edits the immutable
    operational ledger (§28); corrections are new journals.

> Example sale rule: Dr `cash` [total], Cr `sales_revenue` [net], Cr `gst_output` [tax] —
> `postJournal` checks it balances. Pure and deterministic; composes the `Money` primitive.
> Tested in `tests/unit/finance-posting.test.ts`. Part of the repository layout in `CLAUDE.md`.
