# `packages/adjustment/`

Stock adjustment — **M08-FR-03**. A reason-coded correction applied as a **compensating
movement** on the append-only ledger (never an edit, hard rule #2). A **material** adjustment
(value at/above the tenant's threshold) requires an **approval by a different person** (§28
separation of duties).

- **`src/adjustment.ts`** — `commitAdjustment(input, stockLedger, outbox)`: requires a reason
  code; for a material value requires a valid `DecidedRequest` (approved, for this
  adjustment, decided by someone other than the adjuster); appends an `InventoryAdjusted`
  movement and queues it for sync. `MissingReasonError` / `ApprovalRequiredError` guard the
  rules. Idempotent on the adjustment id. Tested in `tests/unit/adjustment.test.ts`.

> Composes `packages/approvals` (the approval is produced upstream), `packages/ledger` and
> `packages/sync`. Part of the repository layout in `CLAUDE.md`.
