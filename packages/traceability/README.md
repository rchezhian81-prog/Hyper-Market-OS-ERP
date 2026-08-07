# `packages/traceability/`

Lot traceability (**M10-FR-03**) and recall (**M10-FR-04**) — trace a batch from supplier to
customer and back, and stop a recalled batch from being sold anywhere.

- **`src/traceability.ts`** — `traceBatch(ledger, batchId)`: a **projection** over the
  append-only ledger that collects every event tagged with the batch, split into **inbound**
  (received) and **outbound** (sold/returned) by the sign of its stock movement — the chain of
  custody, **backwards and forwards** (M10-FR-03). Summarises `receivedQty` / `issuedQty` so a
  discrepancy is visible. Customer references are carried only where captured (PRV).
- **`src/recall.ts`** — `RecallRegistry`:
  - `initiate(...)` marks a batch recalled; the block is **immediate**.
  - `isRecalled(batchId)` / `assertSellable(batchId)` — the POS guard: a recalled batch **cannot
    be sold even offline** (`RecalledBatchError`), enforced from the cached open-recall set.
  - `close(...)` closes a recall **only with evidence** (`MissingRecallEvidenceError`); the
    record and its evidence are **retained, never deleted** (hard rule #6).
  - `openRecalls()` — the set a POS caches to enforce blocks offline.

> Note: full forward-trace to customers depends on sales tagging their batch (from FEFO
> allocation) — the projection traces whatever batch-tagged movements exist today. Composes
> `packages/ledger`. Tested in `tests/unit/traceability.test.ts`. Part of the repository layout
> in `CLAUDE.md`.
