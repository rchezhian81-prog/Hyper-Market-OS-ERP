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

> The core cash sale never depends on the network (hard rule #1); card/UPI show
> pending/declined honestly. Part of the repository layout in `CLAUDE.md`.
