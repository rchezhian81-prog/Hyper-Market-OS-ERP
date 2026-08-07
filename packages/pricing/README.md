# `packages/pricing/`

Line pricing — the core billing calculation (M12 POS, M05 pricing, M23 tax), composed from
the exact-maths primitives in `packages/contracts` (Money, Quantity, Rate). Everything is
exact integer minor units; the only rounding is a single explicit step per money result.

- **`src/pricing.ts`** — `priceLine({ unitPrice, quantity, discountRate?, taxRate, rounding? })`
  → `{ gross, discount, net, tax, total }`. The quantity applies as an exact fraction of its
  UOM's smallest unit (1.234 kg = 1234 g / 1000), so weighed goods price exactly. Tested in
  `tests/unit/pricing.test.ts`.

> This is the first composition brick — it shows the foundation primitives working together
> as a real domain operation. Part of the repository layout in `CLAUDE.md`.
