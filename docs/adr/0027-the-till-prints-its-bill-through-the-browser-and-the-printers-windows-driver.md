# ADR 0027 — The till prints its bill through the browser's own print and the printer's Windows driver

- **Status:** Accepted (real-trading preparation, OB-271, 21 Oct 2026). Switched off during the mirror pilot (OB-248).
- **Date:** 21 October 2026
- **Context:** In real trading the new till's bill is the legal GST tax invoice (CGST Rule 46; roadmap v2.1 A1) and the
  customer must be handed it on paper (CGST s.31; M12-FR-02; M31-FR-02; roadmap §33 "Thermal receipt … printers;
  Tamil/GST output proof"). The pilot-readiness audit (`docs/pilot/audit-2026-10-20/lane-A.md` rows A5, A6) found:
  - no way to hand the customer a paper bill — no `PrinterPort` implementation, no print button, no `window.print()`;
  - the only printer code, `packages/receipt/src/escpos.ts`, encodes ASCII only, so Tamil (template lines, Tamil product
    names) prints as `?`.

  The store PC is Windows 11 with the till in a browser (OB-244, OB-251); the roadmap §19 baseline for the POS is a
  "desktop/PWA shell; sub-second scan; no cloud round trip". The printer model is not yet known (no EX-09 purchase).

## Decision

1. **The till prints with the browser's own print (`window.print()`) of an HTML bill, through the printer's own Windows
   driver.** The bill is laid out for an 80 mm thermal roll (72 mm printable) by default, 58 mm as an option (the
   published receipt template's paper, else the box's `EDGE_BILL_PAPER=thermal-58`). Windows thermal-printer drivers print
   whatever the page draws, so Tamil prints with the computer's own fonts — the foundation's one type stack, whose Tamil
   faces are "Noto Sans Tamil", "Nirmala UI" (it ships with Windows 10/11) and "Latha". Nothing is fetched to print: no
   web font, no network (hard rule #1, strict CSP).
2. **The content comes from one tested place.** `packages/receipt/src/tax-invoice.ts` builds the invoice (`buildTaxInvoice`,
   which runs the A1 checker on every line) and lays it out row by row, each row tagged with the Rule 46 field it carries
   (`taxInvoiceRows`). The contract `invoiceRenderProblems` reads a render back; the till hands a render to the printer
   only when it shows every mandatory field (`apps/pos/src/bill-receipt.ts` `billTaxInvoice`). The page only turns rows
   into nodes (`apps/pos/web/app.js` `printBill`).
3. **Printing never costs the sale.** The sale is committed before the "Print bill" step exists. A print that fails is
   said ("the sale is saved; print again") and the bill stays printable. The first print of a bill is the original; every
   later print is marked **DUPLICATE** at the top (Rule 46 practice: a copy is never passed off as the original).
4. **The ESC/POS encoder stays** for a later raw-printer adapter (with print-failure reporting) if the bought printer
   needs one; it is not used for the bill. It is not extended to Tamil here.

What this does NOT do: it does not choose or buy a printer (EX-09), it does not print silently without the browser's
dialog (that is a browser launch option the owner may choose — see Consequences), and it does not detect paper-out (the
Windows driver does not tell a web page).

## §19-substitution impact

Not a substitution of the §19 baseline — the POS stays a desktop/PWA shell — but it changes the printing approach the
receipt package assumed (raw ESC/POS), so the six axes are recorded:

- **Offline:** unchanged. The bill is built and printed on the till's own PC from the committed sale; no network call.
- **Support:** the owner installs the printer's Windows driver once and sets its paper to the roll width (80 mm or
  58 mm); any printer with a Windows driver works. One fewer moving part than a raw USB/serial adapter.
- **Security:** no new port, process or credential; the print area holds only what the bill prints (never card data —
  the tender line carries the machine's approval number only, hard rule #3).
- **Cost:** nil in software; any Windows-driver thermal printer qualifies.
- **Portability:** the HTML bill prints on any OS/browser with a driver; the row model is printer-neutral and a raw
  adapter can render the same rows.
- **Maintainability:** one layout (the row model) serves the screen copy, the paper and the contract test; Tamil comes
  from system fonts, not from a raster pipeline we would have to maintain.

## Consequences

- Each print shows the browser's print dialog unless the till's browser is started with silent printing (Chrome/Edge
  `--kiosk-printing`, printing to the Windows default printer). The till installer is not changed by this ADR; whether to
  print silently is the owner's choice once the printer is known.
- Paper-out and cover-open are not visible to the page. The cashier sees the paper (or not) and presses Print again; the
  bill is never lost.
- The Tamil wording of the printed labels has not been checked by a Tamil reader (as for the staff sheets, OB-261).

## Reconsider-when

The printer is bought and its Windows driver cannot print Tamil or cannot fit the roll; or the shop wants paper-out
detection or silent printing without a browser flag — then add a raw adapter behind `PrinterPort` rendering the same rows.
