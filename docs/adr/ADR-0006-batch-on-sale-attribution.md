# ADR 0006 — Where the batch on a sale is decided (batch-on-sale attribution)

- **Status:** Accepted. Owner-ratified 11 August 2026 (two decisions, below).
- **Date:** 11 August 2026
- **Context:** M10-FR-03 (supplier-to-customer lot traceability) needs every sale of a
  batch-tracked good (perishables, medicines) to carry the batch it came from, so a recall
  can trace who bought an affected lot. The batch-on-sale workstream delivered the plumbing in
  reviewed increments: inc1 (the sale line can carry a `batchId`, and a batch-tracked sale
  with none is flagged, cloud-side); inc2 (`assignBatchesFefo`, the pure FEFO calculator);
  inc3a (the recall trace's outbound now folds the real banked sales that carried a batch).
  What remained — inc3b — is **who actually decides the batch for a sale, and when.**

An Architecture Decision Record captures a decision, why it was made, and what it commits us
to. This record fixes how a sale acquires its batch, because that choice touches the offline
money path (P-01, hard rule #1) and the store's data-pack size, and must not be made silently.

---

## The decision

**OD-BATCH-01 — The batch is assigned at head office, not at the till.**
When a batch-tracked sale reaches the cloud without a captured batch, head office assigns the
most-likely batch from the stock it holds. The **till and the offline sale path are not
changed**: a sale still commits locally and syncs exactly as before (hard rule #1 untouched),
and the batch is attribution *metadata added alongside the banked sale*, never an edit to it
(hard rule #2 — the sale-intake rule "the server never changes a sale" is preserved; the
attribution is a separate append-only derived record).

**OD-BATCH-02 — A "good-enough" best-estimate is accepted; forensic exactness is not required.**
The store is a single site where the large majority of sales sync within minutes, so a
best-estimate batch is sufficient for a recall. Exact-even-after-days-offline traceability was
explicitly **not** chosen, because it would require carrying per-batch stock onto every till's
offline pack (a heavier download to keep fresh) and a change to the checkout software.

Both were chosen by the owner over the alternatives on 11 August 2026.

---

## The finding that shapes the implementation

Head-office assignment should be **First-Expiry-First-Out** (FEFO — the store sells
earliest-expiry first). But the cloud's inventory ledger (`InventoryMoved`, `services/inventory`
`Movement`) records a movement's `batchId` and `occurredAt` (receipt/movement date) and **does
not carry the batch's expiry date**. Expiry is captured at receipt (M07-FR-02) and is available
to the *edge's* FEFO/expiry list, but it is not on the events the cloud folds.

**Consequence:** head-office attribution is **FIFO by receipt date** (earliest-received
on-hand batch first) as the proxy for FEFO. For a store that receives oldest-expiry stock
first — the normal case — FIFO-by-receipt and FEFO coincide. The estimate is therefore labelled
in the trace by its **basis** (`fifo_receipt_estimate`) so it is never mistaken for a batch the
till actually captured; a captured batch (once inc3b-till, not chosen here, or a future exact
path exists) always wins over an estimate.

A future option, if forensic exactness is ever needed, is to carry batch **expiry** onto the
receipt/inventory events so the cloud can run true FEFO — recorded here as the upgrade path,
not built now (it is not in scope for a single store syncing promptly).

---

## Alternatives considered

- **Assign at the till, offline (rejected — OD-BATCH-02).** Exact even after long offline
  stretches, but requires per-batch stock + expiry in every till's signed pack (bigger pack,
  more sync) and changes the checkout/money path. Not justified for a single promptly-syncing
  store.
- **Carry expiry onto cloud inventory events for true cloud FEFO (deferred).** Cleaner
  attribution, but a broader change to receiving/inventory events for a precision the owner did
  not require. Kept as the documented upgrade path above.
- **Do nothing beyond inc1's flag (rejected).** Leaves every un-captured batch-tracked sale
  merely flagged "untraceable"; the owner chose to add a best-estimate so a recall has a
  starting list, not just a gap.

## Impact

- **Offline (P-01):** none — the offline sale path is untouched; attribution is entirely
  cloud-side and post-sync.
- **Security/audit (P-04, hard rule #2):** the sale is never edited; attribution is a separate
  append-only derived record with its estimate basis stated (P-08). No new PII (customer
  identity linkage is a later M16 step).
- **Cost/maintainability:** reuses the tested `assignBatchesFefo` (inc2) fed cloud on-hand
  batches; no new offline pack data, no checkout change. A recall-time read, not a hot path.
- **Portability:** no new external dependency.

## How this is checked

The batch-on-sale increments each carry unit + integration tests; the `pos-offline` guardrail
proves the sale path still makes no network call. inc3b will add tests that a batch-tracked
sale with no captured batch receives a `fifo_receipt_estimate` attribution from the cloud's
on-hand batches, that a captured batch is never overridden by an estimate, and that the
lot-trace outbound distinguishes captured from estimated in its results.
