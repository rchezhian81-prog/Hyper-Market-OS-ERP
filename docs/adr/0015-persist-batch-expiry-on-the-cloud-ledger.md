# ADR 0015 — Persist batch expiry on the cloud stock ledger (cloud-only)

- **Status:** Accepted (owner-directed, 14 September 2026 — the owner chose "Build A03 Inventory + expiry
  store"). Supersedes, for back-office features only, the expiry omission noted in ADR-0006.
- **Date:** 14 September 2026
- **Context:** ADR-0006 (batch-on-sale attribution, owner-ratified 11 Aug 2026) recorded that *the cloud
  stock ledger carries a batch's receipt date but **not** its expiry*, and deliberately chose
  FIFO-by-receipt-date as the FEFO proxy for sale attribution — because carrying per-batch expiry/stock
  onto every till's **offline pack** would be a heavier download and would change the checkout software
  (OD-BATCH-02). That decision was about the **offline till path**.

  The Inventory agent (A07's sibling, **A03**, §7.1) is meant to predict expiry and suggest **markdowns**
  on near-expiry stock — a real hypermarket waste-reduction lever. `packages/fefo` already has the tested
  `expiryActions`/`proposeMarkdown` engines, but they need a batch's **actual expiry date**, which the
  ledger does not persist. So A03's markdown leg is blocked on this data, and the block traces to ADR-0006.

---

## The decision

**OD-EXPIRY-01 — Persist the batch expiry that goods-receipt already captures, onto the cloud stock
ledger's `received` movement (a new optional field), and read it cloud-side for expiry-driven features
(near-expiry stock, A03 markdown).**

The key point that makes this safe and keeps ADR-0006 intact: **expiry is captured at GOODS-RECEIPT**, which
is a cloud/back-office action (the `captureReceipt` engine already validates that a batch-tracked line has a
batch *and* an expiry). So persisting it:

- **does not touch the offline till path** — the sale still commits locally and syncs unchanged (hard rule
  #1), the till's offline pack is not enlarged, and the checkout software is not changed. ADR-0006's
  OD-BATCH-02 concern is therefore preserved in full.
- **does not change sale→batch attribution** — FIFO-by-receipt-date (ADR-0006 OD-BATCH-01/02) remains the
  proxy for *which batch a sale drew*. This ADR only adds the expiry *of a received batch* so back-office
  features can see it; it does not claim per-sale expiry exactness.

## Consequences

- The `Movement` type gains one **optional** `expiry?` field, populated only on `received` movements from the
  GRN's already-captured line expiry. Every existing movement (and every test that builds one) is unaffected
  because the field is optional and absent by default.
- A cloud-side **near-expiry stock** read becomes possible: fold received movements to net on-hand per batch
  (received minus FIFO-attributed sales minus wastage, reusing the tested `attributeSalesFifo`), then flag the
  batches whose expiry is within a chosen window. A03 turns those into DRAFT markdown suggestions a manager
  commits (hard rule #5).
- Recall (M10-FR-04) and valuation (M08) are unaffected — they do not read the new field.

## Impact (CLAUDE.md §19 dimensions)

- **Offline:** none. The change is entirely cloud/back-office; the offline till path and pack are untouched.
- **Support:** a near-expiry stock list is a new read a manager can be shown; no new failure mode on the money
  path.
- **Security:** no new personal or card data; expiry is product/batch metadata.
- **Cost:** negligible — one optional field on an event already being written.
- **Portability:** the field is part of the documented event model; no new dependency.
- **Maintainability:** reuses existing tested engines (`attributeSalesFifo`, `expiryActions`,
  `proposeMarkdown`); no second copy of batch logic.
