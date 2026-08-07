# `packages/tender/`

Tender settlement — **M12-FR-03** (cash / card / UPI / store credit / split, with explicit
offline rules). Two invariants: split tenders must balance to the total, and **there is
never a fake approval** — a `pending` or `uncertain` tender does not count as paid, so a sale
cannot be settled on an unconfirmed card/UPI authorization (§4.3 / §31).

- **`src/tender.ts`** — `settle(total, tenders)` → `{ settled, pending, outstanding,
  fullyPaid, changeDue }`. Only `authorized`/`settled` tenders count toward payment;
  `pending`/`uncertain` are surfaced separately (honest), `declined` contributes nothing.
  Overpayment yields `changeDue`. Composes the Money primitive. Tested in
  `tests/unit/tender.test.ts`.

- **`src/pending-recovery.ts`** — **pending-payment recovery (D04-FR-02)**: what happens
  when the card machine does not answer and the customer is standing there with a queue
  behind them. Both obvious answers are wrong — assume it worked and the shop hands over
  the goods for nothing; assume it failed and the customer is charged twice. So the tender
  commits as **`uncertain`**, the sale completes locally (hard rule #1), and recovery
  reconciles it against the provider's own authorisation record afterwards.
  - `recoverPendingTender` — confirms paid, confirms not paid, or stays **unknown**. An
    **incomplete** provider record is not a decline: treating it as one is how a shop
    chases a customer who already paid. A double capture from a retried lane, and an
    over-capture for the wrong amount, are both caught.
  - **Money the shop owes is reported as loudly as money it is owed.** A shop that only
    chases debts *to* it and quietly keeps what it owes is not running a control.
  - `pendingExposure` keeps **four numbers apart** at close: recoverable (an identified
    customer can be contacted), unrecoverable (*"treat this as a loss, not a debt"* —
    otherwise it sits on a chase list for a year), owed back to customers, and genuinely
    unknown. A single "pending" total lets a manager close believing the money is late.
  - `dayCloseCheck` **blocks the close only while the shop holds a customer's money** —
    the one thing it can fix tonight and nobody will chase tomorrow. An unknown payment
    does not block: a manager who cannot close starts looking for a way around the system.
  - There is no way to resolve an uncertain tender by hand, in either direction, and a
    test asserts that absence. Tested in `tests/unit/pending-recovery.test.ts` (13) and
    proven end to end in `tests/integration/day-close-honestly.test.ts` (Stage 9 gate).

> The core cash sale never depends on the network (hard rule #1); card/UPI show
> pending/declined honestly. Part of the repository layout in `CLAUDE.md`.
