# `packages/loyalty/`

Loyalty points — earn / burn / reverse (**M17-FR-01**). Points are **money-like**, so they
follow the ledger discipline: every movement is auditable and the balance **reconciles** to the
liability (M23).

- **`src/loyalty.ts`**
  - `earnPoints(input, pointsLedger, outbox)` — an append-only **positive** movement (e.g. from
    a sale).
  - `burnPoints(input, pointsLedger, outbox)` — redeem at tender. Guards: the balance can
    **never go negative** (`InsufficientPointsError`), and an **offline** burn can **never
    exceed the offline cap** (`OfflineCapExceededError`) — the double-spend guard (M12-FR-03 /
    §31).
  - `reversePoints(input, pointsLedger, outbox)` — a compensating **credit** (e.g. a returned
    sale), never an edit of history.
  - `pointsBalance(pointsLedger, customerId)` — the balance, **projected** from the events
    (never stored — mirror of hard rule #2).
  - Idempotent on the movement id: a replay collapses to one effect and does **not** re-run the
    guards.

> Composes `packages/ledger` (an append-only points ledger) and `packages/sync`. Every movement
> is a `PointsMovement` event queued for cloud reconciliation to the loyalty liability (M23).
> Tested in `tests/unit/loyalty.test.ts`. Part of the repository layout in `CLAUDE.md`.
