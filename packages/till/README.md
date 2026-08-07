# `packages/till/`

Cashier shift / till close — **M14-FR-02**. The **blind cash count** and **over/short**:
the cashier counts the drawer without seeing the system-expected figure (blind count protects
integrity), and this engine computes the expected cash and the variance.

- **`src/till.ts`** — `closeShift(input, outbox)`:
  - **Expected cash** = opening float + cash sales − pickups − cash refunds (M14-FR-02).
  - **Variance** = counted − expected (positive = **over**, negative = **short**).
  - A **material** variance (|over/short| at/above the tenant tolerance) must carry a
    **reason code** (`MissingVarianceReasonError`) and raises a valued
    `ReconciliationExceptionRaised` event that escalates (P-03 / M15).
  - Always emits a `TillClosed` event; both events are queued to the **sync outbox**.
  - **Fully offline** (§31 till/shift/close class): no network call is made or awaited — the
    close and any exception reconcile to the cloud later. Idempotent on the shift id.

> The store/day close (M14-FR-04) — which blocks on unresolved exceptions and unsent sync and
> aligns to the trading-day cut-off — is a separate unit (`packages/day-close`). This unit is
> the per-cashier shift close only.
>
> Composes `packages/sync`, the `Money` contract and the `DomainEvent` envelope. Tested in
> `tests/unit/till.test.ts`. Part of the repository layout in `CLAUDE.md`.
