# `apps/picker-app/`

The in-store picker/packer handheld — assigned waves, scan-confirmed picking, controlled
substitutions, weighed final price, quality checks and the dispatch manifest (**M19 / M18 /
D09**). Built to the Stage 3 spec in `docs/design/screens/picker-packer.md`.

Runs on a **low-spec Android handheld in the aisles**, so `src/pick-session.ts` is
**synchronous and local by construction**: the assigned wave is cached, every scan is recorded
locally, and nothing awaits the network (§31 picking row).

## What it enforces (rather than trusting the picker)

- **Every pick is a scan, in order** — `scanBin` → `pick(lineId, scannedProductId, qty)`.
  Confirming before the bin is scanned is refused (`BinNotScannedError`), scanning at the
  **wrong bin** is refused, and scanning the **wrong item** is refused (`WrongItemError`).
  That's the spec's 3-interaction budget, with the order enforced.
- **A short pick is honest** — picking fewer than required marks the line `short` (so the order
  is updated), never a silent complete. Picking *more* than required is refused.
- **A substitution is never the picker's silent choice** — `substitute(...)` delegates to
  `packages/fulfilment`, which **refuses an unconfirmed swap** (A04). Without the customer's
  agreement the line stays short.
- **A weighed line captures its final price at pick** (D09) — 1.234 kg at ₹80/kg is recorded as
  **₹98.72**, exact to the paisa, so the bill matches the crate.
- **Quality failures and shorts need a reason**, recorded against the order.
- **The manifest matches what was packed** — it is **derived** from the picked lines (quality
  failures and zero-pick shorts excluded, substitutes listed under the substitute product and
  flagged), never typed. Packing is **blocked while any line is unresolved**
  (`WaveNotCompleteError`), and cold-chain/tamper evidence is recorded with it (M19-FR-02).
- **PII is minimised** — a pick line carries the **order reference only**, never customer
  details (tested).

## Status

Model complete and tested (17 tests). Remaining: the handheld view layer (large, glove-friendly
targets per the design system) and queueing the scans to the sync outbox — the same
`packages/sync` path the POS already uses.

Tested in `tests/unit/picker-session.test.ts`. Part of the repository layout in `CLAUDE.md`.
