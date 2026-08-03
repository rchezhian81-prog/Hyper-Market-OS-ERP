# `packages/loss-prevention/`

Loss-prevention anomaly rules — **M15-FR-01**. "Control by exception" made concrete (P-03):
surface the risky patterns — suspicious voids, refunds, discounts, no-sales and cash
anomalies — as **exceptions that link to the underlying transactions**, for the owner to act
on. It **detects only**; it never acts (an AI fraud agent may summarise/prioritise, never
sanction — AI-NFR-12).

- **`src/loss-prevention.ts`** — `evaluateLossPrevention(events, rules)`:
  - **Rules are data** — a store tunes its own thresholds "without code" (M15-FR-01). Each
    `LpRule` can limit the **count**, the **total value**, and/or a **single value** per
    cashier for a signal kind, and can mark a spike (`escalateAtMultiple`) as `escalate`
    rather than `flag`.
  - Returns an `LpException` for each breach, carrying the observed amount, the limit, the
    severity, and the **linked transaction ids** (`linkedTxnIds`).
  - **Pure and deterministic** — no storage, no I/O, no clock; it computes signals over
    already-synced data, so output is stable and trivially testable.

> Only kinds with a matching rule are evaluated, so a store enables exactly the rules it
> wants. Values are minor units in the store currency. Tested in
> `tests/unit/loss-prevention.test.ts`. Part of the repository layout in `CLAUDE.md`.
