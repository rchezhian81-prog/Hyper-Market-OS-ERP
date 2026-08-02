# `packages/numbering/`

Gap-free document numbering — **M01-FR-02** (number series are gap-free and unique per
document type; offline lanes use reserved ranges so two lanes offline never produce
duplicate numbers, reconciled on sync).

- **`src/numbering.ts`** — `NumberSeries` (the authoritative cloud series: `allocate` a
  gap-free next number, `reserve` a contiguous block for an offline lane),
  `ReservedRangeAllocator` (a lane allocates within its range, throws when exhausted), and
  `formatNumber` (prefix + zero-padding). Tested in `tests/unit/numbering.test.ts`.

> Because reserved ranges are disjoint by construction, two lanes offline for a day cannot
> collide — the M01-FR-02 acceptance. Part of the repository layout in `CLAUDE.md`.
