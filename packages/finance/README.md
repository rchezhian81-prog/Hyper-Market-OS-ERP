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
    caller-supplied table **overrides** it per product (an exception the filer is handling).
  - **Frozen-at-supply (mid-period rate change):** a sold line may carry its **own** `hsnCode`/`rateBps`
    — the tax facts captured **at the time of supply**. The offline till now **stamps them onto every sale
    line at commit** (read off the pack it priced from — a record only, never a control, so it adds no
    network call and can never refuse a sale, hard rule #1); an import of historical sales can set them too.
    When present, those win over the period table, so a product whose GST rate changed **mid-period** files
    each sale under the rate that actually applied when it sold (the two rates stay as separate HSN/rate
    rows, never blended). `frozenLineCount` reports how many lines used them.
  - From there it is the tested `extractInclusiveGst` primitive — the GST is pulled **back out** of
    each inclusive total (A9), split by place of supply (A8; a counter sale is intra-State CGST+SGST),
    and aggregated by `gstr1Table12`. A product that sold but is **not** in the table, or whose HSN is
    malformed, is returned in `unmapped` (aggregated per product) — **counted and named, never silently
    off the return** (P-08 / hard rule #10).
  - **Returns netted (CGST s.34)** — `netTable12(sales, returns)`: a GSTR-1 for B2C reports outward
    supplies **net of the credit notes** for returns issued in the period. A returned line is just an
    outward supply reversed, so `salesToOutwardSupplies` builds BOTH the sales and the returns Table-12
    (the returned lines reverse the tax at the rate they were **sold**, off the original sale's frozen
    facts), and this nets them per HSN/rate — `sales − returns` filed. A return whose original sale is not
    on file, or a line whose original carried no HSN, surfaces as `unmapped` on the returns side, never
    dropped. The route returns `table12` (sales), `returns`, and `net`.
  - **The GSTN portal file** — `toGstnB2cFromSales(net, {gstin, fp})`: serialises the netted B2C return
    into the **GSTN GSTR-1 JSON the government portal ingests** — `b2cs` (net rate-wise) and `hsn.data`
    (net HSN summary), money paise→rupees. Supplying `gstin`+`fp` on the route returns it as `gstn`; a net
    line may be negative where returns exceeded sales (the filer reviews it against the portal's amendment
    rules — the same owner check the document-path export carries). This turns the whole sales+returns fold
    into an **uploadable filing**, built from real store activity.
  - Pure and deterministic. Wired end-to-end (a read-only fold of the banked sales + returns streams —
    hard rule #1 untouched) at `POST /v1/finance/gstr1/from-sales/table-12`. Tested in
    `tests/unit/finance-outward-from-sales.test.ts` and `tests/integration/gstr1-from-sales.test.ts`.

> Example sale rule: Dr `cash` [total], Cr `sales_revenue` [net], Cr `gst_output` [tax] —
> `postJournal` checks it balances. Pure and deterministic; composes the `Money` primitive.
> Tested in `tests/unit/finance-posting.test.ts`. Part of the repository layout in `CLAUDE.md`.
