# `packages/receiving/`

Goods receiving — **M07** (receiving/GRN), the inbound counterpart to the sale. Received
stock is committed to the local **append-only stock ledger** (positive movements) and a
`GoodsReceived` event is queued to the **sync outbox** — offline-capable (§31) and
idempotent on the GRN id.

- **`src/receiving.ts`** — `commitReceipt(input, stockLedger, outbox)`: one inbound stock
  movement per line + a queued `GoodsReceived`; returns the `CommittedReceipt`; an empty
  receipt throws `EmptyReceiptError`. Pure orchestration (ledger + outbox injected). Tested
  in `tests/unit/receiving.test.ts`.

> Mirrors `packages/sale` for inbound stock; both keep trading with no network (hard rule
> #1). Part of the repository layout in `CLAUDE.md`.
