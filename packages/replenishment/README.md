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
  - **Shelf-life bound (D-3, perishables)** — when an item carries a `remainingShelfLifeDays`
    (with an `avgDailyDemand`), the order-up-to is additionally capped at what can sell before
    the batch expires (`avgDailyDemand × remainingShelfLifeDays`), and the order never lifts the
    holding above that ceiling — a pack/MOQ round-up fits **whole packs under** it. If even the
    smallest compliant order would over-stock, **no order is placed** and the item comes back as a
    visible `held_shelf_life` exception (`suggestedQty 0`) rather than a silent skip. With the
    demand rate unknown it does **not** cap (it never guesses). `shelfLifeCap` / `shelfLifeCapped`
    on the proposal say what the ceiling was and whether it bit.
  - `proposeReplenishmentBatch(inputs)` — the same across many products, returning only those
    that need a reorder (plus any `held_shelf_life` exceptions).
  - **`advisoryOnly: true`** on every proposal: this can **never** become a purchase order by
    itself — an authorised human commits the PO (**hard rule #5 / AI-NFR-12**). **Parameters
    drive every number** (M09-FR-02 acceptance).
- **`src/constrained-order.ts`** — **forecast-driven, constraint-aware order proposal (D-2,
  M09·M06).** Where `proposeReplenishment` answers "are we below the line," this answers the
  buyer's real question: **given how much we expect to sell, and when the supplier next delivers,
  how big should this order be?**
  - `proposeConstrainedOrder(input)` — an order placed now arrives at the **next** delivery and
    must last until the **one after**, so it covers exactly that window's forecast demand (from
    D-1) — no fixed max level. It nets **on-hand + on-order** that will still be there at arrival
    (`projectedOnHandAtArrival = onHand + onOrder − demand-until-arrival`), rounds the shortfall
    **up to whole cases** (`unitsPerCase`, else `orderMultiple`), raises to the supplier
    `minOrderQty` still in whole cases, and reports the **pallet + loose-case** breakdown a buyer
    actually places. `reason` is `ordered`, `covered` (stock at arrival already meets the window),
    or `no_supplier_calendar` (fewer than two upcoming deliveries — it will not guess a cadence).
  - Both constraints — the supplier **calendar** and case/pallet **packaging** — are DATA the
    caller supplies, never inferred here. `advisoryOnly: true`; an authorised human commits the PO
    (**hard rule #5**). Tested in `tests/unit/constrained-order.test.ts`; wired end-to-end (forecast
    folded from banked sales) at `POST /v1/replenishment/order-proposal`, tested in
    `tests/integration/order-proposal.test.ts`.

> Pure and deterministic — no storage, no I/O — so it runs the same on the store edge or in
> the cloud. Composes nothing but plain maths. Tested in `tests/unit/replenishment.test.ts`.
> Part of the repository layout in `CLAUDE.md`.
