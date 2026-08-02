# `packages/contracts/`

Shared API and event contracts, and the exact value primitives (the agreed shapes every
app, service and edge component must honour). Roadmap §30, P-06.

- **`src/money.ts`** — the `Money` value primitive (roadmap §29.1 / M01-FR-02): exact
  integer minor units + explicit currency, **never a float**; add/subtract/negate/compare,
  exact `allocate` / `allocateByRatios` (**no lost paise**), and locale-neutral formatting.
  Tested in `tests/unit/money.test.ts`.
- **`src/index.ts`** — the package's public surface; grows one reviewed, tested unit at a time.

> Source lives in `src/`; tests live in `tests/` (the repo's test layout). Consumed by edge
> and cloud as the single source of shared shapes. Part of the repository layout in `CLAUDE.md`.
