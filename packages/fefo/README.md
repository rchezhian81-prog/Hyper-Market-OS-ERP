# `packages/fefo/`

FEFO allocation & expiry action list — **M10-FR-01**. Stop money leaking to expiry and
protect customers: **sell oldest-first** and **never sell expired or recalled stock**.

- **`src/fefo.ts`**
  - `allocateFefo(batches, productId, requiredQty, asOf)` — allocates a required quantity across
    a product's batches **First-Expiry-First-Out** (earliest expiry first; ties by batchId for
    determinism). Only **sellable** batches are used — `isSellable` excludes expired,
    recall-blocked (M10-FR-04, honoured offline), non-`on_hand` (quarantine/damaged) and empty
    batches. Reports any **shortfall** honestly rather than over-allocating.
  - `expiryActions(batches, asOf, nearExpiryDays)` — the **expiry action list**: every on-hand
    batch that is **expired → dispose** or **near expiry → markdown**, earliest first, with the
    days-to-expiry. Feeds pricing markdown (M05) and waste/disposal (M28).
  - Helpers `isExpired` / `isSellable`.
  - **Pure and deterministic** — the caller passes `asOf` (no clock), so FEFO and the expiry
    list compute identically at the edge from the cached ledger (M10-FR-01 offline rule). An
    expiry date is treated as the **last sellable day**.

> Composes only date maths. Tested in `tests/unit/fefo.test.ts`. Part of the repository layout
> in `CLAUDE.md`.
