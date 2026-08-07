# `packages/stock/`

Stock states, availability and stock health — **M08-FR-02 / M08-FR-04 / §6.2**.

## The 12 that is really 0

A single "quantity on hand" number is the lie at the centre of most retail systems. The
stock is physically in the building, so the report says **12** — but 4 are reserved for an
online order, 3 are quarantined after a damaged delivery, 2 expired yesterday, and 3 are
still on a van from the other branch. The honest answer is **0**, and a system that says 12
will oversell, disappoint a customer and hide a loss.

So stock is held **by state**, and availability is derived:

```
available = the states the tenant treats as sellable
            (never reserved, quarantine, damaged, expired or in-transit)
```

`explainAvailability` returns exactly that, in words: `0 available — 4 reserved,
3 quarantine, 3 damaged, 2 expired not sellable`.

- **`src/position.ts`** — a movement is a **transfer between states**, which makes the model
  self-checking: quantity is conserved everywhere except at the boundary of the business
  (`from: null` is a supplier receipt, `to: null` is a sale or a write-off). The position is
  **projected** from the movements, never stored, so it cannot drift (hard rule #2) and
  replaying gives the same answer.

Two rules are **not** configurable, whatever a tenant would prefer: **expired and quarantined
stock are never sellable** (`NeverSellableStateError`). Everything else is policy — a tenant
may sell from a damaged-goods clearance bin, and may choose whether negative stock is
**blocked** (the default) or **allowed but raised as a visible exception**, never silent
(P-08).

Tracked per **product × location × batch** — never in one lump, because that is the level a
recall, an expiry and a transfer actually operate at.

## Is the money working or dying? (`src/metrics.ts`)

| Metric | What it answers |
|---|---|
| **Ageing** | How long the money has been asleep, bucketed and valued, with each bucket's share of the total. A future-dated lot stays in the report rather than vanishing — a data error must be visible. |
| **Turns** | How many times the stock sold through, annualised for comparison, plus **days of cover**. |
| **GMROI** | Rupees of margin per rupee of stock held. Below **1.00×** a line consumes more cash than it returns, however good its percentage margin looks. |
| **Stockouts** | What the empty shelf cost — the loss that never appears in any sales report, because the sale never happened. Reported explicitly as an **estimate**, never mixed into actuals. |

Ratios are computed in basis points with **BigInt**, so nothing is lost to floating point
(§29.1), and a ratio with a zero denominator returns **`not_meaningful` with the reason**
rather than `Infinity`, `NaN` or a silent zero — a made-up number is worse than an absent one
(P-08).

Pure and deterministic — "now" is passed in, there is no clock, no I/O. Tested in
`tests/unit/stock-position.test.ts` (14 tests) and `tests/unit/stock-metrics.test.ts`
(13 tests). Part of the repository layout in `CLAUDE.md`.
