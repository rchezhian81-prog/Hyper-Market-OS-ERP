# `packages/day-close/`

Store / day close and controlled reopen — **M14-FR-04**. Settle the day and **lock** it,
honouring the **trading-day cut-off** (M01-FR-02). This is the higher-level counterpart to the
per-cashier shift close (`packages/till`).

- **`src/day-close.ts`**
  - `closeDay(input, outbox)` — locks the day only when **all three** hold (the M14-FR-04
    acceptance: "the day cannot close with unresolved exceptions or unsent sales"):
    1. the trading day has **ended** — its cut-off has passed, computed via the trading-day
       calendar (`DayNotEndedError`);
    2. **no unresolved reconciliation exceptions** remain (`UnresolvedExceptionsError`);
    3. **no unsent sync items** remain (`UnsyncedSalesError`).
    On success it emits a **locked** `PeriodClosed` event (a closed day takes append-only
    corrections only) and queues it for sync. Idempotent on the day-close id.
  - `reopenDay(input, outbox)` — a **controlled, audited** reopen: requires a valid approval
    for this day close decided by someone **other than** the person reopening (§28), then emits
    a `PeriodReopened` event. Without a valid approval, `ReopenApprovalRequiredError`.

> Composes `packages/calendar` (trading-day rule), `packages/approvals` (reopen approval) and
> `packages/sync`. Tested in `tests/unit/day-close.test.ts`. Part of the repository layout in
> `CLAUDE.md`.
