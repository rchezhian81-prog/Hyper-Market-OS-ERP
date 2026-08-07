# `packages/receiving/`

Goods receiving — **M07**, the inbound counterpart to the sale, and the door most of the
shop's money actually walks out of. Nothing here trusts the delivery note.

- **`src/receiving.ts`** — `commitReceipt(input, stockLedger, outbox)` (**M07-FR-01**): one
  inbound movement per line onto the local **append-only stock ledger**, plus a queued
  `GoodsReceived` event for the **sync outbox** — offline-capable (§31), idempotent on the
  GRN id. An empty receipt throws `EmptyReceiptError`.
- **`src/capture.ts`** — `captureReceipt(...)` (**M07-FR-02/03**): what was really counted,
  and what may actually be sold.
- **`src/three-way-match.ts`** — `matchInvoice(...)` (**M07-FR-04**): purchase order ↔ goods
  receipt ↔ supplier invoice, with landed cost.

## What the capture refuses to let through

| Refusal | Why |
|---|---|
| A batch-tracked item with **no batch or no expiry** | You cannot trace or recall what you cannot identify (M10). |
| A cold-chain item with **no recorded temperature** | Without evidence there is no cold chain, only a claim (D05-FR-04). |
| **Already-expired** stock as sellable | It is rejected at the door, not written off later. |
| **Damaged**, QC-failed or temperature-breached stock counted as good | It goes to **quarantine** — counted and present, but deliberately **not available to sell** (M08 status). |
| An **excess beyond tolerance** accepted on the receiver's own say-so | Over-delivery is a cost; beyond tolerance it needs a second person (§28). |

Everything else becomes a **valued, owned discrepancy** rather than a silent loss: short
(with the credit note due), near-expiry, an MRP different from the master. Every tolerance
is per-tenant configuration, never a hard-coded number.

## The three-way match

The roadmap's rule is blunt and the code keeps it blunt: **no payment on an unmatched or
out-of-tolerance invoice without an approval** — and **the person who received the goods can
never approve the variance on them** (§28).

- Charged above the agreed cost, invoiced for more than was received, invoiced for something
  never ordered, or invoiced for goods that never arrived → **payment blocked**, with the
  variance **valued** and the largest one named.
- Received but not yet invoiced is reported, not blocked — the buyer needs to know an
  invoice is still coming, or the period closes understating cost.
- **Landed cost** apportions freight and duty across the lines **by value, to the paisa**,
  with the remainder distributed rather than dropped (§29.1). Valuation that ignores freight
  understates cost and overstates margin — the shop then thinks it is making money it is not.

Pure and deterministic — no clock, no I/O; the trading date is passed in. Money is exact
minor units throughout. Tested in `tests/unit/receiving.test.ts` (3 tests) and
`tests/unit/goods-in.test.ts` (23 tests).

> Mirrors `packages/sale` for inbound stock; both keep trading with no network (hard rule
> #1). Part of the repository layout in `CLAUDE.md`.
