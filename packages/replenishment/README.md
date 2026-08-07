# `packages/replenishment/`

Replenishment suggestions — **M09-FR-02**. Work out **what to reorder and how much**, from
per-product parameters — as a **proposal a buyer approves**, never an automatic purchase.

- **`src/replenishment.ts`**
  - `proposeReplenishment(input)` — returns a `ReplenishmentProposal`, or `null` when no
    reorder is needed. It reorders when the **inventory position** (on-hand + on-order −
    reserved) is **at or below the reorder point**, and suggests bringing the position **up to
    the max level**, rounded **up** to the order multiple (pack/case) and raised to the
    supplier **minimum order quantity**. The **reorder point** is explicit, or computed as
    `safety stock + ceil(avg daily demand × lead time)` (safety stock respects lead time). A
    **blocked/discontinued** item is suppressed.
  - `proposeReplenishmentBatch(inputs)` — the same across many products, returning only those
    that need a reorder.
  - **`advisoryOnly: true`** on every proposal: this can **never** become a purchase order by
    itself — an authorised human commits the PO (**hard rule #5 / AI-NFR-12**). **Parameters
    drive every number** (M09-FR-02 acceptance).

> Pure and deterministic — no storage, no I/O — so it runs the same on the store edge or in
> the cloud. Composes nothing but plain maths. Tested in `tests/unit/replenishment.test.ts`.
> Part of the repository layout in `CLAUDE.md`.
