# `packages/gs1/`

Reads a GS1 2D barcode at the till — **roadmap v2.1 D-20** (GS1 Sunrise 2027). Pure and offline: no clock, no network,
no catalogue.

- `parseGs1(code)` reads the three forms a scanner sends — the raw element string (with or without a symbology
  identifier and group separators), the printed `(01)…(17)…(10)…` form, and a GS1 Digital Link web address (read as
  text, never fetched) — into the GTIN (AI 01, check digit verified), the batch (AI 10) and the use-by date (AI 17).
- A code that cannot be read with certainty is refused with `Gs1ParseError` and a named reason. It is never half-read.
- `looksLikeGs1(code)` decides by shape alone, so a plain 1D barcode never takes this path.
- `gtinCandidates(gtin)` gives the 1D codes (GTIN-14, EAN-13, UPC-A, EAN-8) the catalogue may know the product by.

The till's catalogue (`packages/catalogue`) uses it to refuse an expired batch, charge a batch's markdown price, and
refuse only the recalled batch when the code carries the batch (SF-08 · OB-139 "A").
