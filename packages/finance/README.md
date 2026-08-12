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

- **`src/gstr1.ts`** — the **GSTR-1 return** (roadmap v2.1 **A5**): `gstr1Table12` (the HSN-wise
  summary of outward supplies, B2B/B2C split), `gstr1Return` (B2B invoice-level + B2C rate-wise +
  the HSN summary), and `toGstnGstr1` (the GSTN portal JSON — paise→rupees, `YYYY-MM-DD`→`DD-MM-YYYY`).
  The HSN comes from a **closed master, never free text** (`validateOutwardLine` rejects a typed-in
  or malformed HSN), and tax facts are folded from stored outward-supply lines, not re-derived.
- **`src/outward-from-sales.ts`** — **GSTR-1 from the store's own banked till sales** (A5, M23·M12).
  A hypermarket's real outward supplies are the thousands of **B2C counter sales** the till already
  banks, and nobody re-keys each one as an outward-supply document. `salesToOutwardSupplies` turns
  banked sale lines **into** the return:
  - A banked sale line carries only what the till charged — the **MRP-inclusive line total** — not
    the HSN or the tax split. So the derivation needs a **product→{HSN, rate} table**. That table
    **defaults from the published catalogue** (the M03 master's persisted form — the snapshot now carries
    each product's `hsnCode` alongside its rate), so the return builds **with nothing to key by hand**; a
    caller-supplied table **overrides** it per product (an exception the filer is handling). Supplying the
    mapping explicitly is also the freeze-safe answer to "capture the tax as it was": the filer states the
    mapping they are filing this period under.
  - From there it is the tested `extractInclusiveGst` primitive — the GST is pulled **back out** of
    each inclusive total (A9), split by place of supply (A8; a counter sale is intra-State CGST+SGST),
    and aggregated by `gstr1Table12`. A product that sold but is **not** in the table, or whose HSN is
    malformed, is returned in `unmapped` (aggregated per product) — **counted and named, never silently
    off the return** (P-08 / hard rule #10).
  - Pure and deterministic. Wired end-to-end (a read-only fold of the banked sales stream — hard rule
    #1 untouched) at `POST /v1/finance/gstr1/from-sales/table-12`. Tested in
    `tests/unit/finance-outward-from-sales.test.ts` and `tests/integration/gstr1-from-sales.test.ts`.

> Example sale rule: Dr `cash` [total], Cr `sales_revenue` [net], Cr `gst_output` [tax] —
> `postJournal` checks it balances. Pure and deterministic; composes the `Money` primitive.
> Tested in `tests/unit/finance-posting.test.ts`. Part of the repository layout in `CLAUDE.md`.
