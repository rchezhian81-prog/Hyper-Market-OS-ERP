# `packages/waste/`

Waste, scrap, packaging and sustainability — **M28-FR-01…04**. What leaves the shop as loss,
what it was worth, and whether the numbers reported about it can be trusted.

- **`src/waste.ts`** — write-offs (M28-FR-01). `commitWriteOff(input, stockLedger, outbox)`:
  - Requires a **reason code** (`MissingReasonError`) and removes a positive quantity.
  - A **material** loss (value at/above the tenant threshold) needs **captured evidence**
    (photo/witness — `MissingEvidenceError`) **and** an approval by a **different person** (§28,
    enforced by the adjustment engine).
  - Appends **one reason-coded compensating stock movement** (a loss removes stock — never an
    edit, hard rule #2) via `packages/adjustment`, valued for finance (M23).

- **`src/scrap.ts`** — scrap and recycling sales (M28-FR-02). Cardboard, plastic crates, dead
  freezers, cooking oil, damaged stock sold for salvage. In most shops this is the one revenue
  stream with no paperwork and no controls: a man with a van comes on a Tuesday, cash changes
  hands, and nothing anywhere records it. Unrecorded proceeds are the easiest money in a store
  to take, and because nobody knows what a month of cardboard is *worth*, nobody can tell the
  difference between ₹4,000 and ₹12,000. **The control is not suspicion — it is making the
  number exist.**
  - `reviewScrap({ branchId, sales, from, to })` — flags unevidenced sales, unnamed buyers,
    proceeds that never reached the books (*"off-books cash, whatever anyone intended"*), stock
    recorded as sold for nothing, and e-waste or used oil handled without a registered recycler.
  - **An unevidenced sale is flagged, not refused.** Refusing would push the transaction back
    outside the system, which is the situation we started from.
  - **Rate drift is measured against the shop's own running average**, not a configured
    expectation. A hard-coded rate would be wrong within a quarter and would then be ignored;
    an average built from the shop's own history stays honest. The finding asks about the
    **rate**, not about the person, and needs enough history before it says anything at all.
  - An empty month is itself reported as a question — the cardboard still left the building.

- **`src/packaging.ts`** — carry bags and reusable packaging (M28-FR-03).
  - `chargeForBags({ item, policy, bagsIssued, channel? })` — **a bag charge is a visible priced
    line or it does not exist.** Adding an amount to a total without a line on the bill is the
    version of this that ends in a consumer complaint the shop loses, and showing it properly
    costs nothing. Where the tenant has not enabled it there is **no line**, not a line worth
    nothing. Pure arithmetic over the price pack the lane already holds, so it works with the
    internet down (hard rule #1).
  - `projectPackaging({ item, branchId, movements })` — **a reusable crate is an asset in
    circulation, not a consumable.** A shop that treats crates as consumed buys the same 400
    crates every year and never asks where they went; a shop that can see 118 unaccounted for
    asks once and stops buying them. Projected from movements (hard rule #2).
    - **A negative position is reported as negative, not clamped to zero.** Bags going out with
      none recorded in means a goods-in was never entered, and clamping destroys the only
      evidence that it happened — *the negative IS the evidence*.

- **`src/sustainability.ts`** — waste, energy and sustainability reporting (M28-FR-04). This has
  a specific failure mode worth naming, because it is not incompetence but the natural drift of
  any number nobody can check: a store reports *"waste down 18%"*. Waste is not down —
  **recording** is down. The one manager who logged every damaged crate went on leave, and the
  figure improved. Six months later the shop believes it has a waste problem under control that
  it has simply stopped measuring.
  - `buildSustainabilityReport(…)` — **the number carries its coverage**, on the face of the
    report rather than in a footnote. Below 80% coverage the confidence is `not_comparable` in
    those words, and the departments that did not report are named. Waste is valued and broken
    down by source and department, because *"₹2,40,000 of waste"* is a number nobody can act on
    and *"₹1,80,000 of it is fresh produce expiring on the shelf"* is an ordering decision.
    Diversion from landfill is computed on weighed waste only.
  - `compareWaste({ from, to })` — **refuses to call a fall an improvement when coverage
    moved.** If waste fell 18% and coverage fell from 100% to 62%, the honest answer is *"we
    cannot tell"*, and saying so is more use to the owner than a number he will repeat to
    somebody.
  - Nothing here is an AI claim. Every figure is derived arithmetic over recorded events with
    its inputs named, so it can be drilled into (M29) — sustainability numbers get quoted
    publicly, and a number that cannot be traced should never be published.

> Pure and deterministic apart from `commitWriteOff`, which composes `packages/adjustment`,
> `packages/ledger` and `packages/sync`. Pairs with the FEFO expiry action list
> (`packages/fefo`) and the energy figures from `packages/facilities` (M26-FR-04). Tested in
> `tests/unit/waste.test.ts` (8) and `tests/unit/waste-sustainability.test.ts` (29), and proven
> end to end in `tests/integration/beyond-the-till.test.ts` (Stage 16 gate). Part of the
> repository layout in `CLAUDE.md`.
