# `packages/receipt/`

Receipt building, thermal rendering and printing — **M31-FR-02** (receipt/invoice generation)
and **M12-FR-02** (controlled, audited reprints).

## What it does

- **`src/receipt.ts`**
  - `buildReceipt(input)` — builds a validated receipt **from the committed sale** (never a
    draft, M31-FR-02), with its **gap-free number** from `packages/numbering`. It **refuses to
    issue** a receipt that is wrong:
    - a tender reference that looks like a **card number** → `CardDataOnReceiptError`
      (hard rule #3 — a provider token/reference is fine, a PAN never is);
    - **totals that don't balance** (lines ≠ net, tax bands ≠ tax, net + tax ≠ total) →
      `ReceiptTotalsError`;
    - a **reprint with no reason** → `ReprintReasonRequiredError`.
  - `renderText(doc, width)` — renders to plain lines for a thermal printer (32 chars for
    58 mm, 42/48 for 80 mm): centred header, bill/lane/till, each line with its **true weight
    and unit price** (`1.234 kg x 80.00`), the GST bands, the total, tenders and change.
    A long description **wraps rather than truncating**, and a **reprint is stamped
    `*** REPRINT ***` with its reason** so a copy can never be passed off as an original.
- **`src/escpos.ts`**
  - `encodeEscPos(lines, options)` — encodes to **ESC/POS**, the command language essentially
    every thermal printer speaks, so the lane isn't tied to one vendor (P-06). Initialise,
    print, feed, partial cut, optional cash-drawer kick. Non-ASCII prints as `?` rather than
    mojibake — **visible, not silently wrong**.
  - `printReceipt(printer, lines, options)` — writes through the **`PrinterPort`**, the only
    place I/O happens. A printer failure is **returned, never thrown into the sale path**: the
    sale is already committed and stays committed (hard rule #1), so the lane can say *"sale
    saved — printer failed, reprint from the bill list"*.

## Sample output (42-char paper)

```
             SRE HYPER MARKET
                Tamil Nadu
          GSTIN 33XXXXX0000X1Z5
------------------------------------------
Bill: S-0042                    2026-08-02
Lane: lane-1                   Till: Priya
------------------------------------------
Rice 1kg
  2 x 100.00                        200.00
Tomato
  1.234 kg x 80.00                   98.72
------------------------------------------
Subtotal                            298.72
GST 18%                              53.77
TOTAL                               352.49
------------------------------------------
cash                                400.00
Change                               47.51
------------------------------------------
         Thank you - visit again
```

Building and rendering are **pure and synchronous**, so a receipt prints on an offline lane.
Header/footer lines (store name, GSTIN, thanks) are **per-tenant configuration**.

Tested in `tests/unit/receipt.test.ts` (14 tests). Part of the repository layout in `CLAUDE.md`.
