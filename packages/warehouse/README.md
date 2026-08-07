# `packages/warehouse/`

Warehouse execution — **M09-FR-01** (put-away, bin movement, handheld scanning) and
**M09-FR-03** (allocation and inter-store transfers), per §31.1 offline behaviour and WF-07.

- **`src/movements.ts`** — one scanned action at a time, decided as a pure function of the
  facts the caller supplies (bins, current bin contents, commands already applied). It
  returns the ledger movements to append or a refusal with the reason; it never mutates
  anything itself.
  - `applyMovement(...)` — the **duplicate check runs first**, before anything stateful, so
    a re-scan in a dead spot at the back of the racking is a stated no-op rather than a
    second movement. Then four refusals, each protecting something no later report can
    reconstruct:
    - **`unknown_bin`** → queued for resolution, never invented ("somewhere near aisle 4"
      is how stock becomes unfindable);
    - **`bin_full`** → capacity is not advisory; the overflow ends up on the floor;
    - **`insufficient_in_bin`** → moving more than a bin holds would make it negative, and
      every count afterwards would inherit the error;
    - **`not_pickable_state`** → `NEVER_PICKABLE = ['quarantine', 'expired', 'damaged']`
      can never be put away into a pickable bin. This is the commonest route by which bad
      stock reaches a customer — not a decision, a put-away.
  - A refusal returns **no movements at all**, so a rejected scan can never half-write
    (hard rule #2).
  - `suggestPutAway(...)` — prefers a bin that already holds the same product (so one
    product does not scatter across the racking), then any bin with room, and **never**
    suggests a pickable bin for stock that is not sellable.
  - `binKey(...)` / `binOccupancy(...)` — the addressing helpers the caller uses to supply
    current contents.

- **`src/transfers.ts`** — the movement that is in two places at once, which is exactly
  where shops lose it.
  - `dispatchTransfer(...)` — stock leaves the source and becomes **in-transit held at the
    destination**. The van is a place: the receiving branch can see what is coming and
    cannot sell it (`in_transit` is never in `sellableStates`, M08-FR-02). Refused unless
    approved by **someone other than the requester** (§28), and refused outright for
    quarantined, expired, damaged or **recalled** stock — moving a problem to another
    branch launders it, it does not solve it.
  - `receiveTransfer(...)` — in-transit becomes on-hand for what actually arrived; a
    shortfall becomes a **valued `TransferDiscrepancy`** *and* an explicit shortfall
    movement out of transit, so nothing sits in a van for ever and nothing is silently
    absorbed. Stock that left one place and never arrived at another is a miscount or a
    theft, and both need a name against them (P-08, hard rule #10).
  - `proposeAllocation(...)` — **advisory only**; nothing moves until a person approves it.
    When there is not enough for everyone it shares by **days of cover**, not raw
    shortfall: 100 units to a shop selling 5 a day while a shop selling 50 gets nothing is
    how one branch drowns while another runs dry. The last allocation absorbs the rounding
    so no unit is stranded.

> Emits `StockMovement`s for `packages/stock` to project (never a stored quantity), and
> composes `packages/contracts` money for valuing discrepancies exactly. Pure and
> deterministic — timestamps are injected, there is no clock and no I/O. Tested in
> `tests/unit/warehouse-movements.test.ts` (16) and `tests/unit/warehouse-transfers.test.ts`
> (12); proven end to end in `tests/integration/physical-to-system.test.ts` (Stage 8 gate).
> Part of the repository layout in `CLAUDE.md`.
