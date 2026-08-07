# `packages/contracts/`

Shared API and event contracts, and the exact value primitives (the agreed shapes every
app, service and edge component must honour). Roadmap §30, P-06.

- **`src/money.ts`** — the `Money` value primitive (roadmap §29.1 / M01-FR-02): exact
  integer minor units + explicit currency, **never a float**; add/subtract/negate/compare,
  exact `allocate` / `allocateByRatios` (**no lost paise**), and locale-neutral formatting.
  Tested in `tests/unit/money.test.ts`.
- **`src/quantity.ts`** — the `Quantity` value primitive (data dictionary; UOM-aware):
  exact integer counts of a UOM's smallest unit (grams for kg, ml for L), **never a float**;
  parse/add/subtract/negate/multiply/compare and locale-neutral formatting. Tested in
  `tests/unit/quantity.test.ts`.
- **`src/rate.ts`** — the `Rate` primitive (M05 pricing / M23 tax): a proportional rate in
  exact integer **basis points** (18% = 1800 bp); `applyRate` applies it to Money rounding
  to whole minor units with an explicit mode (half-up / half-even / down), using BigInt so
  it's exact and overflow-proof. Tested in `tests/unit/rate.test.ts`.
- **`src/enums.ts`** — shared domain vocabularies and §27.1 universal states (tender kind/
  status, sale status, stock state, approval decision, record lifecycle, connection state),
  each with a runtime guard. Tested in `tests/unit/enums.test.ts`.
- **`src/event.ts`** — the `DomainEvent` envelope (§30.2 / §31.1): id, type, UTC timestamp,
  **idempotency key**, source, version, payload; `makeEvent` validates every field so a
  malformed event can't be published. Tested in `tests/unit/domain-event.test.ts`.
- **`src/index.ts`** — the package's public surface. Value **types** (`Money`, `Quantity`)
  export flat; their **operations** export as namespaces (`MoneyOps.add`, `QuantityOps.add`)
  since they share names. Enums/event helpers export flat. Grows one tested unit at a time.

> Source lives in `src/`; tests live in `tests/` (the repo's test layout). Consumed by edge
> and cloud as the single source of shared shapes. Part of the repository layout in `CLAUDE.md`.
