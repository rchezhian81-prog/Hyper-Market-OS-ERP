# `packages/suspended-sales/`

Suspend/recall and quotations — **M12-FR-02** (with M22 for the B2B quotation path).

Two documents that look like sales and must not behave like them.

- **`src/suspended-bill.ts`** — the parked basket. A cashier suspends one a dozen times a
  day and it is one of the commonest ways a till loses money, for four separate reasons:
  - **It survives the lane restart.** A basket held in the running program is gone when
    the till reboots, and the cashier re-scans forty items from memory. A suspension is
    **serialised state** (`SerialisedSuspendedBillStore`, with `serialise()`/`hydrate()`),
    and the acceptance test does exactly that — writes, discards the store, rebuilds from
    what was on disk, resumes.
  - **Resuming is a claim, not a read.** `resumeBill` succeeds once and refuses every
    attempt afterwards, naming the lane and person who already have it. Two lanes
    resuming one bill is a double charge that both cashiers believe was correct.
  - **A parked bill holds no stock.** Reserving for a suspended basket feels careful and
    is the opposite: a basket abandoned at 11am starves the shelf all day.
  - **A parked bill ages.** Past the tenant's window, `repriceRequired` tells the lane to
    re-price — a promotion that ended at noon is not honoured at six. It still resumes;
    refusing would strand the customer at the counter.
  - `abandonBill` never deletes (hard rule #6) — repeated park-and-abandon is a
    loss-prevention pattern, and a deleted record has no pattern in it. `staleBills` is
    the manager's close-of-day list, oldest first, valued.
  - Cross-lane recall, the re-price window, the abandonment window, whether a reason is
    required and the per-lane limit are all **per-tenant** (`SuspensionPolicy`, OC-29).

- **`src/quotation.ts`** — the price promised, not the sale made.
  - **It moves no stock.** Quote three customers for the same pallet and the shop keeps
    selling it. Nothing in the module touches the ledger.
  - **The price is held, and only for as long as it was promised.** `convertQuotation`
    honours the quoted price inside the validity window and **refuses outside it** —
    never silently re-priced in either direction. A customer shown ₹4,200 and charged
    ₹4,600 is one complaint; honouring a six-week-old quotation is the opposite leak.
  - **You cannot quote your way past the price guard.** A below-floor quotation needs a
    separate approver (§28 / M05-FR-02), and the margin is checked across the **whole**
    quotation — a salesperson can bury a loss-making line inside a healthy one, and the
    customer only ever sees the total.
  - **Converting is idempotent** — one quotation becomes one sale, and a second attempt
    returns the sale that already exists. Partial conversion is allowed; more than was
    quoted is not.
  - `quotationsNeedingFollowUp` surfaces expiring and lapsed quotations soonest-first: an
    unconverted quotation is a sale the shop already did the work for and then lost.

> Pure and deterministic — timestamps injected, no clock, no I/O, no stock. Tested in
> `tests/unit/suspended-bills.test.ts` (15) and `tests/unit/quotations.test.ts` (16), and
> proven end to end in `tests/integration/day-close-honestly.test.ts` (Stage 9 gate).
> Part of the repository layout in `CLAUDE.md`.
